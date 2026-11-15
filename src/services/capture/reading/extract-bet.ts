import type { ParsedBetPost } from "@/src/domain/bet-capture";
import type { CaptureOcrEvidence, OcrReading } from "@/src/domain/capture-ocr-evidence";
import type { CapturePolicy } from "@/src/domain/capture-policy";
import type { CaptureStakeSettings } from "@/src/domain/capture-stake-policy";
import { reconcileImageCaptionSelection } from "@/src/domain/image-caption-selection";
import { extractLiveScoresAtTip, resolveLiveScoreAtTip } from "@/src/domain/live-score-at-tip";
import { marketKindOf } from "@/src/domain/mercados/classify";
import { totalDirectionOf } from "@/src/domain/mercados/total-direction";
import { tokensDaSelecao } from "@/src/domain/settlement/goalscorer-matching";
import { parseLineQuarters } from "@/src/domain/settlement/lines";
import { buildPlayerPropTerms } from "@/src/domain/settlement/player-prop-terms";
import { fixtureHasPlaceholderTeam, normalizeStr, splitEventoTeams } from "@/src/domain/text";
import {
  llmAvailable, llmGenerateJsonOutcome, type LlmCascadeOutcome, type LlmGenerateJsonParams, type LlmJsonResult,
  type LlmPart, type LlmProviderId, type SourceMessageRef,
} from "@/src/infra/llm/cascade";
import { rotuloDoMotivo } from "@/src/domain/recusa-de-captura";
import { createLogger } from "@/src/infra/logger";
import type { CaptureFixOption } from "@/src/services/capture/capture-fix";
import {
  albumReadingPrompt, BASKETBALL_PLAYER_MARKETS, EXTRACTION_CONTRACT_VERSION, imageReadingPrompt, llmBetSchema, PLAYER_PROPS_INSTRUCTION,
  PLAYER_PROPS_RESPONSE_SCHEMA, RESPONSE_SCHEMA, SYSTEM_INSTRUCTION, textReadingPrompt, type LlmBet,
} from "./extraction-contract";
import { extractionEvidence, extractionSourceFields, isUsableBetExtraction, mapLlmBetToParsed, mapLlmBetToParsedList } from "./extraction-mapping";
import { mentionsFloorOdd } from "./incomplete-draft";
import {
  extractionContentProblem, extractionRows, extractionState, missingExtractionNumbers, provenFinancialEvidence,
} from "./extraction-quality";
import { mistralImageProfile, singleBetOcrContract } from "./ocr-extraction-contract";

/*
 * Extração de apostas pela cascata LLM (Gemini → Groq → Mistral), quando o
 * parser universal não resolve. A resposta é input hostil: passa pelo schema,
 * pelos tetos de sanidade e pelo contrato de conteúdo. Enquanto a cascata tenta
 * outros leitores, a melhor leitura incompleta e o motivo de revisão ficam
 * guardados para virar rascunho ou revisão se ninguém resolver.
 */

const log = createLogger("llm-extract");

type ExtractionReview = { reason: string; description: string; evidence: Record<string, unknown> };

/**
 * Grade sem a opção marcada (revisão `unmarked_selection`): a aposta lida,
 * com a primeira opção no lugar da seleção, e as opções que o dono escolhe na
 * DM.
 */
type GridChoice = { bet: ParsedBetPost; options: CaptureFixOption[] };

/** Os campos que algum desfecho da extração usa. */
type ExtractionFields = {
  bet: ParsedBetPost | null;
  bets: ParsedBetPost[];
  provider: LlmProviderId | null;
  notBet: true;
  incompleteDraft: true;
  missing: string[];
  review: ExtractionReview;
  ocrEvidence: CaptureOcrEvidence;
  refused: { reason: string; provider: LlmProviderId | null };
  refusalWhenExhausted: { reason: string };
  withoutOdds: [ParsedBetPost, ...ParsedBetPost[]];
  gridChoice: GridChoice;
};

/** Um desfecho: os campos dele, e nenhum dos outros. */
type Outcome<T extends Partial<ExtractionFields>> = T & { [K in Exclude<keyof ExtractionFields, keyof T>]?: never };

/**
 * Como a extração terminou. Cada desfecho traz só os seus campos: quem lê o
 * resultado não depende de uma combinação que a extração nunca gera.
 */
export type ExtractBetResult =
  /** A leitura aceita: as apostas (`bet` é a primeira), com quem as leu. */
  | Outcome<{ bet: ParsedBetPost; bets?: ParsedBetPost[]; provider: LlmProviderId; ocrEvidence?: CaptureOcrEvidence }>
  /** O provedor respondeu isBet=false. */
  | Outcome<{ bet: null; provider: LlmProviderId | null; notBet: true; ocrEvidence?: CaptureOcrEvidence }>
  /** Faltou stake ou odd: aguarda a edição, sem retry. */
  | Outcome<{ bet: null; provider: LlmProviderId | null; incompleteDraft: true; missing: string[]; ocrEvidence?: CaptureOcrEvidence }>
  /**
   * Só a odd falta, num post cuja única odd é a mínima: as apostas lidas, com
   * a odd 0. A odd não chega numa edição; a captura do canal segue com elas
   * para o guard recusar e perguntar a odd ao dono.
   */
  | Outcome<{ bet: null; provider: LlmProviderId; incompleteDraft: true; missing: ["odds"]; withoutOdds: [ParsedBetPost, ...ParsedBetPost[]]; ocrEvidence?: CaptureOcrEvidence }>
  /** A leitura parou numa revisão; na grade sem a opção marcada, com a escolha que a DM pergunta. */
  | Outcome<{ bet: null; provider: LlmProviderId | null; incompleteDraft: true; missing: string[]; review: ExtractionReview; gridChoice?: GridChoice }>
  /**
   * Os provedores leram e nenhuma leitura virou aposta: reler repetiria a
   * resposta, então a captura recusa em vez de relançar.
   */
  | Outcome<{ bet: null; provider: null; refused: { reason: string; provider: LlmProviderId | null } }>
  /**
   * Algum provedor que leria não respondeu. `refusalWhenExhausted`: outro leu
   * e recusou, e esta é a recusa que vale se as tentativas acabarem sem o
   * primeiro voltar.
   */
  | Outcome<{ bet: null; provider: null; refusalWhenExhausted?: { reason: string } }>;

/** O desfecho da revisão pendente. */
type PendingReview = Extract<ExtractBetResult, { review: ExtractionReview }>;

/**
 * Quem gera o JSON da leitura. A captura usa a cascata inteira; a bancada de
 * modelos (`scripts/bench-leitura.ts`) passa um leitor só, para medir cada
 * modelo com o mesmo contrato, o mesmo julgamento e o mesmo mapeamento.
 */
export type ExtractionGenerator = (params: LlmGenerateJsonParams) => Promise<LlmJsonResult | null>;

type ExtractionRequest = {
  parts: LlmPart[];
  label: string;
  now: Date;
  /** Leitura estreita de bilhetes de jogador, com leitura de precisão. */
  playerProps?: boolean;
  /** Legenda que a seleção da imagem precisa conciliar (foto de bilhete único). */
  imageCaption?: string;
  /** Texto da fonte para contagem de simples e placar ao vivo. */
  sourceText?: string;
  stakeSettings?: CaptureStakeSettings;
  ocrContract?: ReturnType<typeof singleBetOcrContract> & { ocrImageProfile?: "compact-bet365-slip-v1" };
  itemRef?: SourceMessageRef;
  generate?: ExtractionGenerator;
};

/** Leitura que originou um candidato, para a proveniência. */
type ReadingSource = { reading?: OcrReading; sourceFields?: Record<string, unknown> };
type Candidate = ReadingSource & { data: unknown; score: number; provider: LlmProviderId | null };

/*
 * Consenso sobre uma leitura sem aposta completa (rascunho sem número ou
 * "não é aposta"). Modelos do mesmo provedor tendem a errar juntos, e um
 * terceiro modelo ainda pode ler o que dois recusaram. Por isso só leitores de
 * provedores diferentes encerram a busca; três modelos do mesmo provedor
 * concordando apenas passam a vez ao provedor seguinte.
 */
const CONSENSUS_PROVIDERS = 2;
const PROVIDER_AGREEING_READERS = 3;

/** Mesmo rascunho = mesmos números faltando nos mesmos confrontos. */
function draftSignature(data: LlmBet, missing: readonly string[]): string {
  const fixtures = extractionRows(data).map((row) => {
    const teams = splitEventoTeams(row.evento ?? "");
    const key = (team: string) => normalizeStr(team).replace(/[^a-z0-9]/g, "");
    return teams ? `${key(teams.home)}~${key(teams.away)}` : "";
  });
  return `draft:${missing.join(",")}:${fixtures.join("|")}`;
}

/** Opções da grade que o leitor listou na revisão, com odd; o resto da leitura vem junto. */
function gridChoiceOf(review: ExtractionReview, now: Date, stakeSettings?: CaptureStakeSettings): { gridChoice?: GridChoice } {
  if (review.reason !== "unmarked_selection") return {};
  const { options: listed, extraction } = review.evidence as { options?: unknown; extraction?: unknown };
  const options = (Array.isArray(listed) ? listed : []).flatMap((option: { selecao?: unknown; odds?: unknown }) =>
    typeof option.selecao === "string" && option.selecao.trim() && typeof option.odds === "number" && option.odds > 1
      ? [{ selecao: option.selecao.trim(), odds: option.odds }] : []);
  const first = options[0];
  // Sem duas opções não há o que perguntar; sem o resto da leitura, não há aposta.
  if (options.length < 2 || !first || !extraction || typeof extraction !== "object") return {};
  const bet = mapLlmBetToParsed({ ...extraction, review: undefined, items: undefined, selecao: first.selecao, odds: first.odds }, now, stakeSettings);
  return bet ? { gridChoice: { bet, options } } : {};
}

/** Só a odd falta, e o post traz apenas a mínima (ver `mentionsFloorOdd`). */
function onlyFloorOdd(missing: readonly string[], sourceText: string | undefined): boolean {
  return missing.length === 1 && missing[0] === "odds" && Boolean(sourceText && mentionsFloorOdd(sourceText));
}

/** A prova financeira do leitor se confere no texto só quando a fonte não tem imagem. */
function evidenceSourceOf(request: ExtractionRequest): string | undefined {
  return request.parts.some((part) => "inlineData" in part) ? undefined : request.sourceText;
}

/**
 * Julga cada resposta da cascata (`accept`) e lembra o que foi recusado por
 * conteúdo: o rascunho numérico mais completo, uma não-aposta de imagem que
 * outro leitor ainda pode contradizer, a seleção que não concilia com a
 * legenda e o primeiro motivo de revisão.
 */
function createExtractionJudge(request: ExtractionRequest) {
  const { now, stakeSettings, imageCaption, sourceText } = request;
  // ALWAYS define a stake independentemente da fonte. WHEN_MISSING ainda
  // procura outros leitores antes de concluir que a fonte não tem stake.
  const acceptanceStakeSettings = stakeSettings?.stakePolicy === "ALWAYS" ? stakeSettings : undefined;
  const hasImage = request.parts.some((part) => "inlineData" in part);
  const evidenceSource = evidenceSourceOf(request);

  let current: ReadingSource & { provider: LlmProviderId | null } = { provider: null };
  let review: ExtractionReview | undefined;
  let reviewSource: ReadingSource = {};
  let rejectedSelection: (ReadingSource & { reason: string; data: Record<string, unknown> }) | undefined;
  let numericDraft: Candidate | undefined;
  let nonBetCandidate: Candidate | undefined;
  /** Veredito sem aposta completa → leitor (`provedor:modelo`) → provedor. */
  const verdicts = new Map<string, Map<string, LlmProviderId>>();

  const currentSource = (): ReadingSource => ({ reading: current.reading, sourceFields: current.sourceFields });
  /** Registra o veredito do leitor atual e diz se provedores distintos já concordam nele. */
  const agreed = (signature: string): boolean => {
    const reading = current.reading;
    if (!reading) return false;
    const readers = verdicts.get(signature) ?? new Map<string, LlmProviderId>();
    readers.set(`${reading.provider}:${reading.model}`, reading.provider);
    verdicts.set(signature, readers);
    return new Set(readers.values()).size >= CONSENSUS_PROVIDERS;
  };
  const providerAgrees = (provider: LlmProviderId): boolean => [...verdicts.values()].some((readers) =>
    [...readers.values()].filter((reader) => reader === provider).length >= PROVIDER_AGREEING_READERS);
  /** Primeiro motivo de revisão vence; guarda a leitura que o originou. */
  const suggestReview = (next: ExtractionReview) => {
    if (review) return;
    review = next;
    reviewSource = currentSource();
  };

  /** Aposta estruturada recusada pelo contrato é problema de conteúdo: fica
   * visível para revisão se nenhum provedor seguinte der dados utilizáveis. */
  const reviewUnusable = (raw: unknown) => {
    const parsed = llmBetSchema.safeParse(raw);
    if (!parsed.success) {
      if (raw && typeof raw === "object" && !Array.isArray(raw) && (raw as { isBet?: unknown }).isBet === true) {
        suggestReview({ reason: "invalid_extraction_contract",
          description: "Os provedores responderam, mas os campos da aposta não passaram pela validação. Confira a mensagem original.",
          evidence: { issues: parsed.error.issues.slice(0, 10).map((issue) => ({ code: issue.code, path: issue.path.map(String) })) } });
      }
      return;
    }
    if (!parsed.data.isBet) return;
    const data = parsed.data;
    const rows = data.items?.length ? data.items : [data];
    const incomplete = rows.some((row) => !(row.evento || data.evento)?.trim()
      || !(row.selecao || data.selecao)?.trim() || !(row.mercado || data.mercado)?.trim());
    suggestReview(incomplete
      ? { reason: "incomplete_extraction",
        description: "A extração não identificou todos os confrontos, mercados e seleções. Confira a mensagem original antes de registrar a aposta.",
        evidence: data }
      : { reason: "inconsistent_extraction",
        description: "A resposta contém termos incompatíveis com o contrato da aposta. Confira os termos na mensagem original.", evidence: data });
  };

  /**
   * O leitor de jogador precisa ter lido quem, o quê, o lado e a linha. O
   * artilheiro tem contrato próprio (só o nome), e a prop que a liquidação
   * automática ainda não cobre (pontos de jogadora no basquete) é aposta
   * completa quando o jogador, o lado e a linha foram lidos: ela vai para a
   * liquidação manual, não para a revisão da leitura.
   */
  const playerTermsComplete = (data: LlmBet) => extractionRows(data).every((row) => {
    const mercado = row.mercado || "", selecao = row.selecao || "";
    const kind = marketKindOf(mercado, selecao, row.evento);
    if (kind === "scorer") return tokensDaSelecao(selecao).length > 0 || Boolean(row.playerProp?.jogador);
    const terms = buildPlayerPropTerms({ evento: row.evento, esporte: row.esporte, mercado, selecao, playerProp: row.playerProp });
    if (terms) return Boolean(terms.jogador && terms.direction && terms.lineQuarters !== null);
    // Fora do futebol, só pontos ou rebotes do jogo inteiro, já no mercado de
    // jogador: "Total de pontos" sem o nome seria gravado como o total do jogo,
    // e cestas de 3 ou pontos de um quarto não são pontos do jogo.
    return BASKETBALL_PLAYER_MARKETS.has(mercado) && Boolean(row.playerProp?.jogador)
      && totalDirectionOf(selecao, { allowBarePositiveLine: true }) !== null
      && parseLineQuarters(selecao, { allowNegative: false }) !== null;
  });

  const accept = (raw: unknown): boolean => {
    // Outra leitura sem o termo não desfaz a prova já transcrita.
    if (review?.reason === "unsupported_promotion_terms" || review?.reason === "unsupported_trading_terms") return false;
    const parsed = llmBetSchema.safeParse(raw);
    const problem = parsed.success ? extractionContentProblem(parsed.data, sourceText, evidenceSource) : null;
    // A prova financeira vale mesmo numa transcrição com seleção cortada.
    if (problem !== "unsupported_promotion_terms" && problem !== "unsupported_trading_terms"
      && !isUsableBetExtraction(raw)) {
      reviewUnusable(raw);
      return false;
    }
    if (!parsed.success) return false;
    const data = parsed.data;
    if (!data.isBet) {
      if (extractionContentProblem(data) || numericDraft || review || rejectedSelection) return false;
      if (!hasImage) return true;
      // Uma recusa visual não basta para descartar a imagem: outro leitor
      // qualificado ainda pode achar um bilhete legível.
      nonBetCandidate ??= { data: raw, score: 0, ...current };
      return agreed("not_bet");
    }
    if (problem) {
      const financial = problem === "unsupported_promotion_terms" || problem === "unsupported_trading_terms" ? problem : null;
      const financialEvidence = financial && [data, ...(data.items ?? [])]
        .map((row) => provenFinancialEvidence(row, financial, evidenceSource)).find(Boolean);
      review = { reason: problem,
        description: financial
          ? `${rotuloDoMotivo(problem)}${financialEvidence ? `. Evidência: ${financialEvidence}` : ""}`
          : data.review?.description ?? "A extração não preservou todos os confrontos, seleções ou evidências da mensagem. Confira a fonte original.",
        evidence: data.review ? { ...data.review, extraction: data }
          : Object.fromEntries(Object.keys(data).map((key) => [key, (raw as Record<string, unknown>)[key]])) };
      reviewSource = currentSource();
      return false;
    }
    if (request.playerProps && !playerTermsComplete(data)) {
      suggestReview({ reason: "incomplete_player_terms",
        description: "A extração não identificou jogador, estatística, lado e linha de todas as seleções. Confira o bilhete original.", evidence: data });
      return false;
    }
    const missing = missingExtractionNumbers(data, acceptanceStakeSettings);
    // Só a mínima como odd: nenhum leitor vai achar outra, então não espera consenso.
    if (missing.length && !onlyFloorOdd(missing, sourceText)) {
      const rows = extractionRows(data);
      const score = rows.length * 10 + rows.reduce((sum, row) => sum + Number((row.odds ?? 0) > 1) + Number((row.stake ?? 0) > 0), 0);
      if (!numericDraft || score > numericDraft.score) numericDraft = { data: raw, score, ...current };
      // O consenso não troca um rascunho mais completo, já lido, por um pior.
      return agreed(draftSignature(data, missing)) && score >= numericDraft.score && !review && !rejectedSelection;
    }
    // Um leitor viu a grade sem a opção marcada: outro que escolheu um lado
    // chutou, e a dúvida fica para o dono.
    if (review?.reason === "unmarked_selection") return false;
    if (imageCaption === undefined) return true;
    const bets = mapLlmBetToParsedList(raw, now, stakeSettings, { withoutOdds: onlyFloorOdd(missing, sourceText), evidenceSource });
    if (!bets) return false;
    const reconciliation = reconcileImageCaptionSelection(bets, imageCaption);
    if (!reconciliation.ok) {
      rejectedSelection = { reason: reconciliation.reason, data: raw as Record<string, unknown>, ...currentSource() };
      reviewSource = currentSource();
    }
    return reconciliation.ok;
  };

  return {
    accept,
    skipRemainingModels: providerAgrees,
    onReading: (reading: OcrReading, raw: unknown) => {
      current = { provider: reading.provider, reading, sourceFields: extractionSourceFields(raw) };
    },
    onOcrConflict: (raw: unknown) => {
      if (review?.reason === "unsupported_promotion_terms" || review?.reason === "unsupported_trading_terms") return;
      const parsed = llmBetSchema.safeParse(raw);
      if (parsed.success) review = {
        reason: "ocr_split_handicap_conflict",
        description: "O handicap extraído diverge da linha dividida transcrita na imagem. Confira o bilhete original; nenhum valor foi corrigido automaticamente.",
        evidence: parsed.data,
      };
      reviewSource = currentSource();
    },
    /** Sem resposta aceita, o melhor rascunho (ou a não-aposta de imagem) vale
     * só se nenhuma revisão ficou pendente. */
    settle(generated: LlmJsonResult | null) {
      const fallback = numericDraft ?? nonBetCandidate;
      const result = generated ?? (fallback && !review && !rejectedSelection
        ? { data: fallback.data, provider: fallback.provider } : null);
      const source = !generated && fallback ? fallback : current;
      const provenance = (state: CaptureOcrEvidence["state"], bets?: ParsedBetPost[]) =>
        extractionEvidence(source.reading, source.sourceFields, state, bets);
      const withReviewEvidence = (pending: ExtractionReview, from: ReadingSource) => {
        const evidence = extractionEvidence(from.reading, from.sourceFields, "review");
        return { ...pending, evidence: { ...pending.evidence, ...(evidence ? { ocrEvidence: evidence } : {}) } };
      };
      /** Prova financeira vem antes de dúvidas de seleção; nunca oferece só corrigir o lado. */
      const pendingReview = (): PendingReview | null => {
        if (rejectedSelection && review?.reason !== "unsupported_promotion_terms" && review?.reason !== "unsupported_trading_terms") return { bet: null, provider: null, incompleteDraft: true, missing: ["selecao"], review: withReviewEvidence({
          reason: rejectedSelection.reason, description: "A seleção da legenda não pôde ser conciliada com os nomes e linhas da imagem.", evidence: rejectedSelection.data,
        }, rejectedSelection) };
        if (review) return { bet: null, provider: null, incompleteDraft: true, missing: [review.reason], review: withReviewEvidence(review, reviewSource) };
        return null;
      };
      return { result, provenance, pendingReview };
    },
  };
}

/**
 * A cascata diz como terminou sem leitura aceita. O leitor único da bancada só
 * devolve a leitura ou nada, e o nada dele segue como antes: sem recusa.
 */
async function generateOutcome(generate: ExtractionGenerator | undefined, params: LlmGenerateJsonParams): Promise<LlmCascadeOutcome> {
  if (!generate) return llmGenerateJsonOutcome(params);
  const result = await generate(params);
  return result ? { kind: "accepted", ...result } : { kind: "unavailable", responded: false };
}

async function extract(request: ExtractionRequest): Promise<ExtractBetResult> {
  if (!request.generate && !(await llmAvailable())) return { bet: null, provider: null };
  const { label, now, stakeSettings, playerProps } = request;
  const judge = createExtractionJudge(request);
  const evidenceSource = evidenceSourceOf(request);
  const acceptanceStakeSettings = stakeSettings?.stakePolicy === "ALWAYS" ? stakeSettings : undefined;
  const outcome = await generateOutcome(request.generate, {
    parts: request.parts,
    systemInstruction: playerProps ? PLAYER_PROPS_INSTRUCTION : SYSTEM_INSTRUCTION,
    responseSchema: playerProps ? PLAYER_PROPS_RESPONSE_SCHEMA : RESPONSE_SCHEMA,
    label,
    ...(request.itemRef ? { itemRef: request.itemRef } : {}),
    contractVersion: EXTRACTION_CONTRACT_VERSION,
    cacheContext: JSON.stringify([now.toISOString(), stakeSettings]),
    deadlineAt: Date.now() + 100_000,
    contentState: (raw) => extractionState(raw, acceptanceStakeSettings),
    sourceContentState: (raw) => extractionState(raw),
    stakePolicy: stakeSettings?.stakePolicy ?? "MESSAGE",
    onReading: judge.onReading,
    ...request.ocrContract,
    onOcrConflict: judge.onOcrConflict,
    ...(playerProps ? { precisionVision: true } : {}),
    accept: judge.accept,
    skipRemainingModels: judge.skipRemainingModels,
  });
  const generated = outcome.kind === "accepted" ? { data: outcome.data, provider: outcome.provider } : null;
  const { result, provenance, pendingReview } = judge.settle(generated);
  if (!result) {
    const pending = pendingReview();
    if (pending) return { ...pending, ...gridChoiceOf(pending.review, now, stakeSettings) };
    // Todos os provedores recusaram: nenhum deles é o autor da leitura.
    if (outcome.kind === "refused") return { bet: null, provider: null, refused: { reason: "leitura_recusada_pela_ia", provider: null } };
    if (outcome.kind === "unavailable" && outcome.responded) {
      return { bet: null, provider: null, refusalWhenExhausted: { reason: "leitura_recusada_com_provedor_fora" } };
    }
    return { bet: null, provider: null };
  }

  const parsed = llmBetSchema.safeParse(result.data);
  if (parsed.success && !parsed.data.isBet) {
    const pending = pendingReview();
    if (pending) return pending;
    const evidence = provenance("not_bet");
    return { bet: null, provider: result.provider, notBet: true, ...(evidence ? { ocrEvidence: evidence } : {}) };
  }

  if (parsed.success && parsed.data.isBet) {
    const data = parsed.data;
    if (data.review) return { bet: null, provider: result.provider, incompleteDraft: true,
      missing: [data.review.reason], review: { ...data.review, evidence: data.review },
    };
    if (extractionRows(data).some((row) => fixtureHasPlaceholderTeam(row.evento || ""))) return {
      bet: null, provider: result.provider, incompleteDraft: true, missing: ["evento"],
      review: { reason: "incomplete_fixture", description: "Os confrontos não estão completos na mensagem. Não é possível criar adversários para completar a aposta.", evidence: data },
    };
    const missing = missingExtractionNumbers(data, stakeSettings);
    if (missing.length > 0) {
      log.info({ label, provider: result.provider, missing }, "aposta do LLM incompleta — rascunho");
      const evidence = provenance("draft");
      const ocr = evidence ? { ocrEvidence: evidence } : {};
      const [firstWithoutOdds, ...restWithoutOdds] = onlyFloorOdd(missing, request.sourceText)
        ? mapLlmBetToParsedList(result.data, now, stakeSettings, { withoutOdds: true, evidenceSource }) ?? []
        : [];
      if (firstWithoutOdds && result.provider) {
        const withoutOdds: [ParsedBetPost, ...ParsedBetPost[]] = [firstWithoutOdds, ...restWithoutOdds];
        if (evidence) for (const [itemIndex, bet] of withoutOdds.entries()) bet.ocrEvidence = { ...evidence, itemIndex };
        return { bet: null, provider: result.provider, incompleteDraft: true, missing: ["odds"], withoutOdds, ...ocr };
      }
      return { bet: null, provider: result.provider, incompleteDraft: true, missing, ...ocr };
    }
  }

  const mapped = mapLlmBetToParsedList(result.data, now, stakeSettings, { evidenceSource });
  const reconciled = mapped && request.imageCaption !== undefined
    ? reconcileImageCaptionSelection(mapped, request.imageCaption)
    : null;
  const bets = reconciled ? (reconciled.ok ? reconciled.bets : null) : mapped;
  const [first] = bets ?? [];
  // O accept do juiz já exige o que o map exige; se ainda assim a leitura
  // aceita não virar aposta, reler daria a mesma resposta: recusa.
  if (!bets || !first) {
    log.warn({ label, provider: result.provider }, "JSON aceito mas map falhou");
    return { bet: null, provider: null, refused: { reason: "leitura_nao_mapeada", provider: result.provider } };
  }
  const { sourceText } = request;
  if (sourceText && bets.length === 1) {
    const bet = first;
    const live = resolveLiveScoreAtTip({ liveScoreHome: bet.liveScoreHome, liveScoreAway: bet.liveScoreAway,
      texts: [bet.selecao, bet.liveScoreEvidence, sourceText], market: bet.mercado });
    if (!live.ok) return { bet: null, provider: result.provider, incompleteDraft: true, missing: [live.reason],
      review: { reason: live.reason, description: "O placar da legenda conflita com a leitura do bilhete.", evidence: parsed.success ? parsed.data : {} } };
    if (live.score) Object.assign(bet, { liveScoreHome: live.score.home, liveScoreAway: live.score.away });
    if (live.score && !bet.liveScoreEvidence && extractLiveScoresAtTip(sourceText, { market: bet.mercado }).length) bet.liveScoreEvidence = sourceText;
  }
  // Aposta sem o leitor identificado não é gravada: não há de quem é a leitura.
  if (!result.provider) return { bet: null, provider: null };
  const ocrEvidence = provenance("complete", bets);
  if (ocrEvidence) for (const [itemIndex, bet] of bets.entries()) bet.ocrEvidence = { ...ocrEvidence, itemIndex };
  return { bet: first, bets, provider: result.provider, ...(ocrEvidence ? { ocrEvidence } : {}) };
}

export async function extractBetFromText(
  text: string,
  now: Date,
  stakeSettings?: CaptureStakeSettings,
  itemRef?: SourceMessageRef,
  generate?: ExtractionGenerator,
): Promise<ExtractBetResult> {
  return extract({ parts: [{ text: textReadingPrompt(text) }], label: "channel-text", now, stakeSettings, sourceText: text, itemRef, generate });
}

export async function extractBetFromImage(
  image: { base64: string; mimeType: string },
  caption: string,
  now: Date,
  stakeSettings?: CaptureStakeSettings & { capturePolicy?: CapturePolicy },
  itemRef?: SourceMessageRef,
  generate?: ExtractionGenerator,
): Promise<ExtractBetResult> {
  const parts: LlmPart[] = [
    { inlineData: { mimeType: image.mimeType, data: image.base64 } },
    { text: imageReadingPrompt(caption) },
  ];
  return extract({
    parts, label: "channel-image", now, stakeSettings, imageCaption: caption, sourceText: caption, itemRef, generate,
    ocrContract: { ...singleBetOcrContract(caption), ocrImageProfile: await mistralImageProfile(image.base64) },
  });
}

/** Páginas de um álbum do Telegram, na ordem, com uma legenda e uma lista de simples. */
export async function extractBetsFromImages(images: Array<{ base64: string; mimeType: string }>, caption: string, now: Date, stakeSettings?: CaptureStakeSettings, itemRef?: SourceMessageRef, generate?: ExtractionGenerator): Promise<ExtractBetResult> {
  if (!images.length || images.length > 10) return { bet: null, provider: null, incompleteDraft: true, missing: ["album_invalido"] };
  return extract({
    parts: [
      { text: albumReadingPrompt(images.length, caption) },
      ...images.map((image) => ({ inlineData: { data: image.base64, mimeType: image.mimeType } })),
    ],
    label: "channel-album", now, playerProps: true, stakeSettings, sourceText: caption, itemRef, generate,
  });
}

export async function extractPlayerBetsFromImage(image: { base64: string; mimeType: string }, caption: string, now: Date, stakeSettings?: CaptureStakeSettings, itemRef?: SourceMessageRef, generate?: ExtractionGenerator): Promise<ExtractBetResult> {
  return extract({
    parts: [{ inlineData: { mimeType: image.mimeType, data: image.base64 } }, { text: imageReadingPrompt(caption, { maxChars: 4000 }) }],
    label: "channel-player-image", now, playerProps: true, stakeSettings, sourceText: caption, itemRef, generate,
  });
}
