import type { OcrReading } from "@/src/domain/capture-ocr-evidence";
import type { CaptureStakePolicy } from "@/src/domain/capture-stake-policy";
import { createLogger } from "@/src/infra/logger";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { createCorrelationId, runWithObservabilityContext } from "@/src/infra/observability-context";
import { recordOperationalMetric } from "@/src/infra/operational-metrics";
import { geminiAvailable, geminiConfigured, geminiGenerateJson } from "./gemini";
import { groqAvailable, groqConfigured, groqGenerateJson } from "./groq";
import { mistralAvailable, mistralConfigured, mistralGenerateJson } from "./mistral";
import { evaluationOrder, PROVIDER_ORDER, visionEvaluationEnabled } from "./models";

const log = createLogger("llm-cascade");

/* Contrato neutro de geração JSON multimodal: Gemini, Groq e Mistral recebem os
 * mesmos parâmetros e devolvem o JSON aceito ou null; a cascata decide a ordem. */

export type LlmProviderId = "gemini" | "groq" | "mistral";

/** Mensagem de origem nas métricas, sem guardar chat, texto ou imagem. */
export type SourceMessageRef = { chatIdHash: string; messageId: number };

export type LlmPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

export type LlmGenerateJsonParams = {
  contractVersion?: string;
  cacheContext?: string;
  /** Total capture deadline, shared with fallback and verification. */
  deadlineAt?: number;
  contentState?: (data: unknown) => "invalid" | "not_bet" | "review" | "draft" | "complete";
  /** Source completeness remains distinct from a server-owned fixed stake. */
  sourceContentState?: LlmGenerateJsonParams["contentState"];
  stakePolicy?: CaptureStakePolicy;
  onReading?: (reading: OcrReading, data: unknown) => void;
  parts: LlmPart[];
  systemInstruction: string;
  /** Schema JSON Schema (Gemini usa nativo; Groq/Mistral só reforçam via prompt). */
  responseSchema: Record<string, unknown>;
  /** Optional dedicated OCR contract; only the single-slip capture path opts
   * in. The OCR prompt already contains its explicit caption context. Other
   * providers continue to use systemInstruction/responseSchema. */
  ocrSystemInstruction?: string;
  ocrResponseSchema?: Record<string, unknown>;
  ocrSchemaName?: string;
  /** Domain validation of the dedicated OCR subset, before the shared accept. */
  ocrAccept?: (data: unknown) => boolean;
  /** Optional source-based completion, owned by the narrow extraction contract. */
  ocrNormalize?: (data: unknown) => unknown;
  /** Deterministic image-format gate, supplied by capture code, never by the model. */
  ocrImageProfile?: "compact-bet365-slip-v1";
  /** Preserve a proven OCR conflict for review after other models are tried. */
  onOcrConflict?: (data: unknown) => void;
  label: string;
  /**
   * Referencia curta da mensagem de origem. Vai para as metricas para o
   * painel apontar o post que ninguem conseguiu ler sem guardar chat,
   * texto ou imagem.
   */
  itemRef?: SourceMessageRef;
  /** Small player slips require precise OCR; do not reuse a lightweight text-model preference. */
  precisionVision?: boolean;
  /**
   * Se retornar false, a resposta conta como falha — Gemini tenta próxima
   * combinação; a cascata segue para Groq/Mistral. Evita “grudar” em JSON
   * incompleto (ex.: aposta sem odd).
   */
  accept?: (data: unknown) => boolean;
  /** O chamador já tem leituras concordantes o bastante deste provedor: os
   * modelos restantes dele são pulados e a vez passa ao provedor seguinte. */
  skipRemainingModels?: (provider: LlmProviderId) => boolean;
  /** Cada rota do provedor avisa, pelo modelo, se respondeu com conteúdo ou se
   * ficou sem resposta: transporte, cota, cooldown, circuito aberto, resposta
   * vazia ou o tempo acabar antes da vez dela. */
  onRouteOutcome?: (outcome: "responded" | "unavailable", model: string) => void;
};

export type LlmJsonResult = {
  data: unknown;
  provider: LlmProviderId;
};

/**
 * Como a cascata terminou. `unavailable`: algum provedor que leria não foi
 * ouvido (transporte, cota, cooldown, circuito ou prazo), e outra tentativa
 * pode ler; `responded` diz se algum outro leu e recusou. `refused`: todos os
 * que podiam ler responderam e nenhuma resposta foi aceita; repetir a leitura
 * repetiria as mesmas respostas.
 */
export type LlmCascadeOutcome =
  | ({ kind: "accepted" } & LlmJsonResult)
  | { kind: "unavailable"; responded: boolean }
  | { kind: "refused" };

const PROVIDERS: Record<LlmProviderId, {
  /** Sem chave ou desligado por configuração: não é queda, nunca leria. */
  configured: () => boolean;
  available: () => Promise<boolean>;
  generate: (params: LlmGenerateJsonParams) => Promise<unknown | null>;
}> = {
  gemini: { configured: () => geminiConfigured(), available: () => geminiAvailable(), generate: (params) => geminiGenerateJson(params) },
  groq: { configured: () => groqConfigured(), available: () => groqAvailable(), generate: (params) => groqGenerateJson(params) },
  mistral: { configured: () => mistralConfigured(), available: () => mistralAvailable(), generate: (params) => mistralGenerateJson(params) },
};

function configured(provider: LlmProviderId): boolean {
  try {
    return PROVIDERS[provider].configured();
  } catch {
    // Sem saber, a cascata supõe que ele leria: relançar é o lado seguro.
    return true;
  }
}

async function available(provider: LlmProviderId): Promise<boolean> {
  try {
    return await PROVIDERS[provider].available();
  } catch (err) {
    log.error({ eventCode: LOG_EVENTS.LLM_PROVIDER_FAILED, reason: "availability_check", err, provider },
      "cascata LLM: falha ao checar disponibilidade do provedor");
    return false;
  }
}

async function run(provider: LlmProviderId, params: LlmGenerateJsonParams): Promise<{ data: unknown | null; threw: boolean }> {
  try {
    return { data: await PROVIDERS[provider].generate(params), threw: false };
  } catch (err) {
    log.error(
      { eventCode: LOG_EVENTS.LLM_PROVIDER_FAILED, reason: "unhandled_exception", err, label: params.label, provider },
      "cascata LLM: exceção não tratada no provedor — avançando para próximo",
    );
    return { data: null, threw: true };
  }
}

/** True se ao menos um provedor da cascata está configurado e com circuit fechado. */
export async function llmAvailable(): Promise<boolean> {
  for (const provider of PROVIDER_ORDER) {
    if (await available(provider)) return true;
  }
  return false;
}

/**
 * Cascata Gemini → Groq → Mistral. Retorna o primeiro JSON válido com o
 * provedor que resolveu; null se todos falharam ou estão indisponíveis.
 */
export async function llmGenerateJson(
  params: LlmGenerateJsonParams,
): Promise<LlmJsonResult | null> {
  const outcome = await llmGenerateJsonOutcome(params);
  return outcome.kind === "accepted" ? { data: outcome.data, provider: outcome.provider } : null;
}

/** A cascata com o desfecho: quem só relança quando provedor caiu usa este. */
export async function llmGenerateJsonOutcome(
  params: LlmGenerateJsonParams,
): Promise<LlmCascadeOutcome> {
  return runWithObservabilityContext({
    llmCallId: createCorrelationId("llm"),
    llmCallStartedAtMs: Date.now(),
    llmEvaluationRandomized: visionEvaluationEnabled(params),
  }, async () => {
    const startedAt = Date.now();
    const state: CascadeState = { contentRejected: false, providersDown: [], providersUnreached: [], responded: false };
    let outcome: "success" | "error" | "expected_retry" = "error";
    let exhaustion: "unavailable" | "refused" | undefined;
    try {
      const result = await generateObserved(params, state);
      outcome = cascadeOutcome(result, state);
      if (result) return { kind: "accepted", ...result };
      exhaustion = cascadeExhaustion(state);
      return exhaustion === "refused" ? { kind: "refused" } : { kind: "unavailable", responded: state.responded };
    } catch (err) {
      log.error({ eventCode: LOG_EVENTS.LLM_CASCADE_COMPLETED, label: params.label,
        outcome, reason: "unhandled_exception", durationMs: Date.now() - startedAt, err }, "cascata LLM interrompida");
      throw err;
    } finally {
      await recordOperationalMetric({ kind: "provider", name: "llm.cascade", outcome,
        durationMs: Date.now() - startedAt, labels: { task: params.label, contentRejected: state.contentRejected,
          ...(state.providersDown.length ? { providersDown: state.providersDown.join(",") } : {}),
          ...(exhaustion ? { exhaustion } : {}) } });
    }
  });
}

type CascadeState = {
  contentRejected: boolean;
  /** Provedores com algum modelo sem resposta: transporte, cota, cooldown,
   * resposta vazia ou tempo esgotado antes da vez dele. */
  providersDown: LlmProviderId[];
  /** Configurados e não ouvidos: circuito aberto, prazo esgotado antes da vez
   * deles ou exceção no adaptador. */
  providersUnreached: LlmProviderId[];
  /** Algum provedor devolveu conteúdo, aceito ou não. */
  responded: boolean;
};

/**
 * Sem leitura aceita, só é recusa quando todo provedor que podia ler foi
 * ouvido e ao menos um respondeu. Um recusou e outro caiu: ninguém sabe o
 * que o outro leria, e a captura relança.
 */
function cascadeExhaustion(state: CascadeState): "unavailable" | "refused" {
  return state.responded && state.providersDown.length === 0 && state.providersUnreached.length === 0
    ? "refused" : "unavailable";
}

/**
 * Recusa de conteúdo sem resposta aceita é o desfecho esperado de uma imagem
 * que não é aposta completa, desde que todos os provedores tentados tenham de
 * fato lido. Se um deles caiu por transporte ou cota, ninguém sabe se ele leria:
 * a cascata conta como falha, para o SLO de `llm.cascade` enxergar a queda
 * parcial que o SLO por transporte já não alerta.
 */
function cascadeOutcome(result: LlmJsonResult | null, state: CascadeState): "success" | "error" | "expected_retry" {
  if (result) return "success";
  return state.contentRejected && state.providersDown.length === 0 ? "expected_retry" : "error";
}

async function generateObserved(params: LlmGenerateJsonParams, state: CascadeState): Promise<LlmJsonResult | null> {
  const startedAt = Date.now();
  const providersTried: LlmProviderId[] = [];
  const providerOrder = evaluationOrder(PROVIDER_ORDER, params);
  const providersSkipped: LlmProviderId[] = [];
  const summary = (reason: string, provider?: LlmProviderId) => ({
    eventCode: LOG_EVENTS.LLM_CASCADE_COMPLETED,
    label: params.label, reason, provider, providersTried, providersSkipped,
    providersDown: state.providersDown,
    durationMs: Date.now() - startedAt,
    outcome: provider ? "success" : cascadeOutcome(null, state),
    ...(provider ? {} : { exhaustion: cascadeExhaustion(state), providersUnreached: state.providersUnreached }),
  });
  for (const [index, provider] of providerOrder.entries()) {
    if (Date.now() >= (params.deadlineAt ?? Infinity)) {
      state.providersUnreached.push(...providerOrder.slice(index).filter(configured));
      break;
    }
    if (!(await available(provider))) {
      providersSkipped.push(provider);
      if (configured(provider)) state.providersUnreached.push(provider);
      continue;
    }
    providersTried.push(provider);
    const providerStartedAt = Date.now();
    let contentRejected = false;
    let ocrConflict = false;
    // Um modelo conta como ouvido quando alguma rota dele (outra chave, por
    // exemplo) respondeu; basta um modelo sem resposta para o provedor não
    // ter sido ouvido: ninguém sabe o que ele leria.
    const models = new Map<string, "responded" | "unavailable">();
    const accept = params.accept;
    const observedParams: LlmGenerateJsonParams = {
      ...params,
      onRouteOutcome: (outcome, model) => {
        if (models.get(model) !== "responded") models.set(model, outcome);
        params.onRouteOutcome?.(outcome, model);
      },
      ...(accept ? { accept: (data) => {
        const accepted = accept(data);
        if (!accepted) { contentRejected = true; state.contentRejected = true; }
        return accepted;
      } } : {}),
      onOcrConflict: (data) => {
        ocrConflict = true;
        state.contentRejected = true;
        params.onOcrConflict?.(data);
      },
    };
    const { data, threw } = await run(provider, observedParams);
    const modelOutcomes = [...models.values()];
    if (modelOutcomes.includes("unavailable")) state.providersDown.push(provider);
    if (threw) state.providersUnreached.push(provider);
    const accepted = data !== null && (!observedParams.accept || observedParams.accept(data));
    if (data !== null || modelOutcomes.includes("responded") || contentRejected || ocrConflict) state.responded = true;
    log.info({
      eventCode: LOG_EVENTS.LLM_PROVIDER_COMPLETED,
      label: params.label, provider, durationMs: Date.now() - providerStartedAt,
      outcome: accepted ? "success" : "no_result",
      reason: accepted ? "accepted" : ocrConflict ? "ocr_conflict"
        : contentRejected ? "content_rejected" : "no_usable_response",
    }, "cascata LLM: etapa do provedor concluída");
    if (data !== null) {
      if (!accepted) continue;
      log.info(summary(provider === providerOrder[0] ? "primary_accepted" : "fallback_accepted", provider),
        "cascata LLM concluída");
      return { data, provider };
    }
  }
  log.warn(summary(providersTried.length ? "providers_exhausted" : "no_provider_available"),
    "cascata LLM esgotada");
  return null;
}
