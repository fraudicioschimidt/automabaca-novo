import { randomInt } from "node:crypto";
import { getEnv } from "@/src/infra/env";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { createLogger } from "@/src/infra/logger";
import type { LlmGenerateJsonParams, LlmProviderId } from "./cascade";

const log = createLogger("llm-models");

/** Tipo de leitura; cada provedor tem uma lista de modelos para cada um. */
export type ReadingKind = "text" | "vision" | "precisionVision" | "ocr";
export type ProviderModels = Readonly<Record<ReadingKind, readonly string[]>>;

/** A ordem dos provedores na cascata. */
export const PROVIDER_ORDER: readonly LlmProviderId[] = ["gemini", "groq", "mistral"];

/**
 * Catálogo único dos modelos da cascata: em cada provedor, a lista de cada
 * tipo de leitura na ordem em que é tentada. A cascata, o card de Operações e
 * a bancada leem daqui; mudar modelo ou ordem é mudar o código.
 *
 * - `text`: pedido sem imagem (post de texto, IA-Judge, formatação da busca).
 * - `vision`: print com imagem.
 * - `precisionVision`: print de jogador e álbum. Sem os Gemini lite: a leitura
 *   de precisão não herda um modelo leve.
 * - `ocr`: OCR anotado da Mistral, só para o bilhete simples, antes do chat.
 *
 * O nome é o que vai na requisição e no rótulo das métricas (`llm.attempt`).
 * Por isso só nomes canônicos (um apelido `latest` troca de modelo sem aviso),
 * nenhum Gemini retirado (`googleVisionModelEnabled`) e uma família Mistral por
 * lista, porque os apelidos dividem a quota; `tests/providers/llm-models.test.ts`
 * confere. A rota lembrada do Gemini ainda passa um modelo da lista para a
 * frente em texto e imagem; a busca web tem lista própria (`GEMINI_SEARCH_MODELS`).
 */
const MODEL_CATALOG: Readonly<Record<LlmProviderId, ProviderModels>> = {
  gemini: {
    text: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash"],
    vision: [
      "gemini-3.1-flash-lite", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3.5-flash", "gemini-3.5-flash-lite",
      "gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash", "gemini-3-flash-preview",
    ],
    precisionVision: ["gemini-2.5-flash", "gemini-3.5-flash", "gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash", "gemini-3-flash-preview"],
    ocr: [],
  },
  groq: {
    text: ["qwen/qwen3.8-27b"],
    vision: ["qwen/qwen3.8-27b"],
    precisionVision: ["qwen/qwen3.8-27b"],
    ocr: [],
  },
  mistral: {
    text: ["mistral-small-2603", "mistral-medium-2604", "ministral-8b-2512", "ministral-14b-2512", "ministral-3b-2512", "labs-leanstral-1-5-1"],
    vision: ["mistral-small-2603", "mistral-medium-2604", "ministral-8b-2512", "ministral-14b-2512", "ministral-3b-2512", "labs-leanstral-1-5-1"],
    precisionVision: ["mistral-small-2603", "mistral-medium-2604", "ministral-8b-2512", "ministral-14b-2512", "ministral-3b-2512", "labs-leanstral-1-5-1"],
    ocr: ["mistral-ocr-4-0", "mistral-ocr-2512", "mistral-ocr-4-1"],
  },
};

let exclusions: { raw: string | undefined; models: ReadonlySet<string> } | undefined;

/** `provedor/modelo` de `LLM_MODELS_DISABLED` que existem no catálogo. O que
 * não existe (grafia errada, modelo que já saiu) é ignorado, com um aviso. */
function disabledModels(): ReadonlySet<string> {
  const raw = getEnv().LLM_MODELS_DISABLED;
  if (exclusions && exclusions.raw === raw) return exclusions.models;
  const known = new Set(Object.entries(MODEL_CATALOG).flatMap(([provider, lists]) =>
    Object.values(lists).flat().map((model) => `${provider}/${model}`)));
  const listed = csvList(raw);
  const unknown = listed.filter((entry) => !known.has(entry));
  if (unknown.length) {
    log.warn({ eventCode: LOG_EVENTS.LLM_MODELS_DISABLED_UNKNOWN, unknown },
      "LLM_MODELS_DISABLED cita modelo fora do catálogo; ignorado");
  }
  exclusions = { raw, models: new Set(listed.filter((entry) => known.has(entry))) };
  return exclusions.models;
}

/**
 * Os modelos do provedor que a cascata usa: o catálogo menos o que
 * `LLM_MODELS_DISABLED` desligou. A alavanca tira um modelo quebrado sem
 * deploy; não acrescenta nem reordena.
 */
export function cascadeModels(provider: LlmProviderId): ProviderModels {
  const lists = MODEL_CATALOG[provider];
  const disabled = disabledModels();
  if (disabled.size === 0) return lists;
  const enabled = (models: readonly string[]) => models.filter((model) => !disabled.has(`${provider}/${model}`));
  return { text: enabled(lists.text), vision: enabled(lists.vision), precisionVision: enabled(lists.precisionVision), ocr: enabled(lists.ocr) };
}

/** A lista do pedido: texto, imagem ou visão de precisão. O OCR é à parte. */
export function modelsForRequest(models: ProviderModels, params: Pick<LlmGenerateJsonParams, "parts" | "precisionVision">): readonly string[] {
  if (!hasImageParts(params)) return models.text;
  return params.precisionVision ? models.precisionVision : models.vision;
}

/** Os modelos de chat do provedor, de qualquer leitura, sem repetir. */
export function chatModels(models: ProviderModels): string[] {
  return [...new Set([...models.text, ...models.vision, ...models.precisionVision])];
}

/** Lista separada por vírgula do .env, sem itens vazios. */
export function csvList(raw: string | undefined): string[] {
  return raw?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
}

function hasImageParts(params: Pick<LlmGenerateJsonParams, "parts">): boolean {
  return params.parts.some((part) => "inlineData" in part);
}

export function visionEvaluationEnabled(params: LlmGenerateJsonParams): boolean {
  return getEnv().LLM_VISION_EVALUATION === "1" && hasImageParts(params);
}

/** Em avaliação de visão, sorteia a primeira rota e mantém a ordem de fallback
 * das demais. Não duplica leituras nem muda aceite ou prazos. */
export function evaluationOrder<T>(items: readonly T[], params: LlmGenerateJsonParams): T[] {
  if (!visionEvaluationEnabled(params) || items.length < 2) return [...items];
  const index = randomInt(items.length);
  return [...items.slice(index, index + 1), ...items.slice(0, index), ...items.slice(index + 1)];
}

const GOOGLE_ALIASES: Record<string, string> = {
  "gemini-flash-latest": "gemini-3.8-flash",
  "gemini-flash-lite-latest": "gemini-3.5-flash-lite",
  "gemini-pro-latest": "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite-preview": "gemini-3.1-flash-lite",
  "gemini-3-pro-image-preview": "gemini-3-pro-image",
  "nano-banana-pro-preview": "gemini-3-pro-image",
};

/**
 * Modelos Google testados e retirados da leitura de apostas: geradores de
 * imagem, uso de computador, robótica e Gemma não leem bilhete, e modelo que
 * responde 404 gasta o orçamento de captura antes de a vez passar. Ficam fora
 * do catálogo e do histórico do card. Um apelido conta pelo nome canônico
 * (`googleModelFamily`).
 */
const DISABLED_GOOGLE_VISION_MODELS = new Set([
  "gemini-3.1-flash-image",
  "gemini-3.1-flash-image-preview",
  "gemini-3.1-flash-lite-image",
  "gemini-3-pro-image",
  "gemini-2.5-flash-image",
  "gemini-2.5-computer-use-preview-10-2025",
  "gemma-4-31b-it",
  "gemma-4-26b-a4b-it",
  "gemini-3.1-pro-preview-customtools",
  "gemini-3.1-pro-preview",
  "gemini-2.5-pro",
  "gemini-robotics-er-2-preview",
]);

export const googleModelFamily = (model: string) => GOOGLE_ALIASES[model.replace(/^models\//, "")] ?? model.replace(/^models\//, "");

export function googleVisionModelEnabled(model: string): boolean {
  return !DISABLED_GOOGLE_VISION_MODELS.has(model.replace(/^models\//, ""));
}

/** Geradores de imagem não têm saída estruturada: pedem só texto e passam
 * pelo validador local completo; dado de imagem gerada nunca é aceito. */
export const googleUsesPromptJson = (model: string) => /-image(?:-|$)|computer-use/.test(model);

/** Grupos de apelidos do /v1/models desta conta. Fixe modelos implantados: um
 * novo apelido `latest` não é um fallback testado de forma independente. */
const MISTRAL_FAMILIES: Record<string, readonly string[]> = {
  "mistral-small-2603": ["mistral-small-latest", "mistral-vibe-cli-fast", "magistral-small-latest"],
  "mistral-medium-2604": ["mistral-medium-latest", "mistral-medium", "mistral-medium-3-5", "mistral-medium-3.5", "mistral-medium-3", "mistral-vibe-cli-latest", "mistral-vibe-cli-with-tools", "magistral-medium-latest"],
  "ministral-3b-2512": ["ministral-3b-latest"],
  "ministral-8b-2512": ["ministral-8b-latest"],
  "ministral-14b-2512": ["ministral-14b-latest"],
  "labs-leanstral-1-5-1": ["labs-leanstral-1-5"],
  "mistral-ocr-2512": ["mistral-ocr-3-0", "mistral-ocr-3"],
  "mistral-ocr-4-0": [],
  "mistral-ocr-4-1": ["mistral-ocr-latest", "mistral-ocr-4"],
};

export function mistralModelFamily(model: string): string {
  return Object.entries(MISTRAL_FAMILIES).find(([canonical, aliases]) => canonical === model || aliases.includes(model))?.[0] ?? model;
}
