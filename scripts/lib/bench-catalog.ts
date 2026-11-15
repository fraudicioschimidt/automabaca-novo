import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import { getEnv } from "@/src/infra/env";
import { llmErrorStatus } from "@/src/infra/llm/attempt-metrics";
import { httpErrorMessage } from "@/src/infra/llm/chat-json";
import { geminiKeyPool } from "@/src/infra/llm/gemini";
import { cascadeModels, googleModelFamily, mistralModelFamily, PROVIDER_ORDER, type ReadingKind } from "@/src/infra/llm/models";
import { safeMessage, type BenchRoute } from "./bench-call";
import { failureAction, type ProviderLane } from "./bench-schedule";

/*
 * Catálogo de modelos das três APIs, com o que cada chave enxerga. Tira o que
 * não gera texto (embedding, áudio, vídeo, música, moderação, transcrição),
 * junta apelidos do mesmo modelo e marca os que o catálogo de produção
 * (`src/infra/llm/models.ts`) usa. Quem não informa se aceita imagem passa por
 * uma sonda: uma imagem com um número.
 */

export type CatalogEntry = BenchRoute & {
  listed: boolean;
  /** Leituras em que o catálogo de produção usa o modelo (texto, imagem...). */
  inUse: string[];
  aliases: string[];
  visionSource: "api" | "sonda" | "nome";
  availability: "ok" | "indisponivel" | "sem_cota" | "nao_sondado";
  note?: string;
};

export type Catalog = {
  generatedAt: string;
  entries: CatalogEntry[];
  filtered: Array<{ provider: string; model: string; reason: string }>;
  /** Nomes crus devolvidos por cada API, antes de qualquer filtro. */
  listedNames: Record<string, string[]>;
};

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GROQ_BASE = "https://api.groq.com/openai/v1";
const DEFAULT_MISTRAL_BASE = "https://api.mistral.ai/v1";

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(`${url.replace(/\?.*/, "")}: HTTP ${response.status} ${safeMessage(httpErrorMessage(body) ?? "")}`);
  return body;
}

type RawGemini = { name: string; supportedGenerationMethods?: string[] };
type RawGroq = { id: string; active?: boolean; input_modalities?: string[]; output_modalities?: string[] };
type RawMistral = { id: string; aliases?: string[]; capabilities?: Record<string, boolean> };

async function listGemini(): Promise<RawGemini[]> {
  const key = geminiKeyPool()[0];
  if (!key) return [];
  const models: RawGemini[] = [];
  let pageToken = "";
  do {
    const body = await getJson(`${GEMINI_BASE}/models?pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ""}`, { "x-goog-api-key": key }) as { models?: RawGemini[]; nextPageToken?: string };
    models.push(...(body.models ?? []));
    pageToken = body.nextPageToken ?? "";
  } while (pageToken);
  return models.map((model) => ({ ...model, name: model.name.replace(/^models\//, "") }));
}

async function listOpenAiCompatible<T>(base: string, key: string | undefined): Promise<T[]> {
  if (!key?.trim()) return [];
  const body = await getJson(`${base.replace(/\/+$/, "")}/models`, { Authorization: `Bearer ${key.trim()}` }) as { data?: T[] };
  return body.data ?? [];
}

/** Por que um modelo do Gemini não serve para ler aposta; null se serve. */
function geminiFilterReason(model: RawGemini): string | null {
  const methods = model.supportedGenerationMethods ?? [];
  if (!methods.includes("generateContent")) {
    if (methods.includes("embedContent")) return "embedding";
    if (methods.some((method) => method.startsWith("predict"))) return "gera imagem ou vídeo";
    if (methods.includes("generateAnswer")) return "AQA (resposta com fonte, sem geração livre)";
    if (methods.some((method) => method.startsWith("bidi"))) return "só tempo real (Live API, áudio)";
    return "não gera conteúdo";
  }
  if (/tts/i.test(model.name)) return "TTS (gera áudio)";
  if (/^lyria/i.test(model.name)) return "gera música";
  if (/transcribe/i.test(model.name)) return "transcrição de áudio";
  return nameExclusion("gemini", model.name);
}

/** Exclusões por nome que valem também para um catálogo já salvo. */
function nameExclusion(provider: string, model: string): string | null {
  if (provider === "gemini" && /^deep-research/i.test(model)) return "agente de pesquisa: só atende pela Interactions API, não lê bilhete";
  return null;
}

/** Aplica as exclusões atuais a um catálogo salvo antes delas. */
export function refilterCatalog(catalog: Catalog): Catalog {
  const excluded = catalog.entries.map((entry) => ({ entry, reason: nameExclusion(entry.provider, entry.model) }));
  return {
    ...catalog,
    entries: excluded.filter((item) => !item.reason).map((item) => item.entry),
    filtered: [...catalog.filtered, ...excluded.flatMap((item) => item.reason ? [{ provider: item.entry.provider, model: item.entry.model, reason: item.reason }] : [])],
  };
}

function groqFilterReason(model: RawGroq): string | null {
  if (model.active === false) return "inativo na conta";
  if (model.output_modalities && !model.output_modalities.includes("text")) {
    return model.output_modalities.includes("speech") ? "TTS (gera áudio)" : "transcrição de áudio";
  }
  if (/guard/i.test(model.id)) return "moderação (classificador de segurança)";
  return null;
}

function mistralFilterReason(model: RawMistral): string | null {
  const capabilities = model.capabilities ?? {};
  if (capabilities.ocr) return null;
  if (capabilities.completion_chat) return null;
  if (/embed/i.test(model.id)) return "embedding";
  if (capabilities.moderation || capabilities.classification) return "moderação";
  if (capabilities.audio_speech) return "TTS (gera áudio)";
  if (capabilities.audio_transcription || capabilities.audio_transcription_realtime) return "transcrição de áudio";
  return "não gera texto por chat";
}

const READING_LABEL: Record<ReadingKind, string> = { text: "texto", vision: "imagem", precisionVision: "visão de precisão", ocr: "OCR" };

/**
 * Modelos que a captura usa hoje, os do catálogo de produção, com as leituras
 * de cada um. Na bancada eles são só o padrão: `--modelos` escolhe qualquer
 * modelo que as chaves enxerguem.
 */
export function productionModels(): Record<string, Array<{ model: string; source: string }>> {
  return Object.fromEntries(PROVIDER_ORDER.map((provider) => {
    const models = cascadeModels(provider);
    return [provider, (Object.keys(READING_LABEL) as ReadingKind[])
      .flatMap((kind) => models[kind].map((model) => ({ model, source: READING_LABEL[kind] })))];
  }));
}

/** Palpite de visão pelo nome, para quem a API não informa; a sonda confirma. */
function visionByName(provider: string, model: string): boolean {
  if (provider === "gemini") return true;
  if (provider === "groq") return /vision|qwen3\.8/i.test(model);
  if (/^(mistral-large|pixtral-large|codestral|mistral-code|voxtral|mistral-ocr|mistral-embed|mistral-moderation)/i.test(model)) return false;
  return /^(?:pixtral|mistral-small|mistral-medium|magistral|ministral-(?:3b|8b|14b)|mistral-vibe|labs-leanstral)/.test(model)
    || /vision|pixtral/i.test(model);
}

/** Grupos de apelidos da Mistral; o nome canônico é o do projeto ou o datado. */
function mistralGroups(models: readonly RawMistral[]): Array<{ canonical: string; members: string[]; raw: RawMistral }> {
  const groups: Array<{ canonical: string; members: string[]; raw: RawMistral }> = [];
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.id)) continue;
    const members = [...new Set([model.id, ...(model.aliases ?? [])])];
    for (const member of members) seen.add(member);
    const family = mistralModelFamily(model.id);
    const listed = members.filter((member) => models.some((other) => other.id === member));
    const canonical = listed.includes(family) ? family : listed.find((member) => /\d{4}$|-\d+-\d+$/.test(member)) ?? model.id;
    groups.push({ canonical, members: listed, raw: model });
  }
  return groups;
}

export async function listCatalog(): Promise<Catalog> {
  const env = getEnv();
  const [gemini, groq, mistral] = await Promise.all([
    listGemini(),
    listOpenAiCompatible<RawGroq>(env.GROQ_BASE_URL?.trim() || DEFAULT_GROQ_BASE, env.GROQ_API_KEY),
    listOpenAiCompatible<RawMistral>(env.MISTRAL_BASE_URL?.trim() || DEFAULT_MISTRAL_BASE, env.MISTRAL_API_KEY),
  ]);
  const inUse = productionModels();
  const entries: CatalogEntry[] = [];
  const filtered: Catalog["filtered"] = [];
  const usedBy = (provider: string, names: readonly string[]) => [...new Set((inUse[provider] ?? [])
    .filter((use) => names.includes(use.model) || names.includes(provider === "mistral" ? mistralModelFamily(use.model) : googleModelFamily(use.model)))
    .map((use) => use.source))];

  const geminiNames = gemini.map((model) => model.name);
  for (const model of gemini) {
    const reason = geminiFilterReason(model);
    if (reason) { filtered.push({ provider: "gemini", model: model.name, reason }); continue; }
    const family = googleModelFamily(model.name);
    if (family !== model.name && geminiNames.includes(family)) continue;
    const aliases = geminiNames.filter((name) => name !== model.name && googleModelFamily(name) === model.name);
    entries.push({ provider: "gemini", model: model.name, endpoint: "generate", vision: true, visionSource: "nome", listed: true,
      inUse: usedBy("gemini", [model.name, ...aliases]), aliases, availability: "nao_sondado" });
  }
  for (const model of groq) {
    const reason = groqFilterReason(model);
    if (reason) { filtered.push({ provider: "groq", model: model.id, reason }); continue; }
    entries.push({ provider: "groq", model: model.id, endpoint: "chat", listed: true, aliases: [], availability: "nao_sondado",
      vision: model.input_modalities ? model.input_modalities.includes("image") : visionByName("groq", model.id),
      visionSource: model.input_modalities ? "api" : "nome", inUse: usedBy("groq", [model.id]) });
  }
  for (const group of mistralGroups(mistral)) {
    const reason = mistralFilterReason(group.raw);
    if (reason) { filtered.push({ provider: "mistral", model: group.members.join(", "), reason }); continue; }
    const ocr = Boolean(group.raw.capabilities?.ocr);
    entries.push({ provider: "mistral", model: group.canonical, endpoint: ocr ? "ocr" : "chat", listed: true,
      aliases: group.members.filter((member) => member !== group.canonical), availability: "nao_sondado",
      vision: ocr || Boolean(group.raw.capabilities?.vision), visionSource: "api", inUse: usedBy("mistral", group.members) });
  }
  // Modelo configurado que a API não lista continua no teste: é a prova de que a configuração ficou velha.
  for (const [provider, uses] of Object.entries(inUse)) {
    for (const use of uses) {
      const known = entries.some((entry) => entry.provider === provider && (entry.model === use.model || entry.aliases.includes(use.model)
        || (provider === "mistral" && entry.model === mistralModelFamily(use.model))
        || (provider === "gemini" && entry.model === googleModelFamily(use.model))));
      if (known) continue;
      const ocr = provider === "mistral" && use.model.startsWith("mistral-ocr");
      entries.push({ provider: provider as BenchRoute["provider"], model: use.model, endpoint: provider === "gemini" ? "generate" : ocr ? "ocr" : "chat",
        vision: ocr || visionByName(provider, use.model),
        visionSource: "nome", listed: false, inUse: [...new Set(uses.filter((other) => other.model === use.model).map((other) => other.source))],
        aliases: [], availability: "nao_sondado", note: "em uso no projeto, mas a API não lista" });
    }
  }
  return {
    generatedAt: new Date().toISOString(), entries, filtered,
    listedNames: { gemini: geminiNames, groq: groq.map((model) => model.id), mistral: mistral.map((model) => model.id) },
  };
}

/* Sonda de visão: uma imagem com um número, uma resposta curta. */

const PROBE_NUMBER = "47";
async function probeImage(): Promise<string> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#fff"/><text x="100" y="75" font-family="DejaVu Sans, Arial, sans-serif" font-size="72" font-weight="bold" text-anchor="middle" fill="#000">${PROBE_NUMBER}</text></svg>`;
  return (await sharp(Buffer.from(svg)).png().toBuffer()).toString("base64");
}
const PROBE_PROMPT = "Qual número está escrito na imagem? Responda só com o número.";

type ProbeReply = { ok: true; text: string } | { ok: false; status: number; message: string; retryAfter?: string | null; timedOut: boolean };

async function probeOnce(entry: CatalogEntry, image: string): Promise<ProbeReply> {
  const env = getEnv();
  try {
    if (entry.provider === "gemini") {
      const ai = new GoogleGenAI({ apiKey: geminiKeyPool()[0] ?? "", httpOptions: { retryOptions: { attempts: 1 } } });
      const response = await ai.models.generateContent({ model: entry.model,
        contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: image } }, { text: PROBE_PROMPT }] }],
        config: { temperature: 0, abortSignal: AbortSignal.timeout(90_000) } });
      return { ok: true, text: response.text ?? "" };
    }
    const base = entry.provider === "groq" ? env.GROQ_BASE_URL?.trim() || DEFAULT_GROQ_BASE : env.MISTRAL_BASE_URL?.trim() || DEFAULT_MISTRAL_BASE;
    const key = (entry.provider === "groq" ? env.GROQ_API_KEY : env.MISTRAL_API_KEY)?.trim() ?? "";
    const response = await fetch(`${base.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: entry.model, temperature: 0, messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: `data:image/png;base64,${image}` } }, { type: "text", text: PROBE_PROMPT }] }] }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.json().catch(() => undefined) as { choices?: Array<{ message?: { content?: string } }> } | undefined;
    if (!response.ok) return { ok: false, status: response.status, message: httpErrorMessage(body) ?? `HTTP ${response.status}`, retryAfter: response.headers.get("retry-after"), timedOut: false };
    return { ok: true, text: body?.choices?.[0]?.message?.content ?? "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: llmErrorStatus(error) ?? 0, message, retryAfter: message.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i)?.[1] ?? null,
      timedOut: error instanceof Error && /timeout|abort/i.test(error.name) };
  }
}

const IMAGE_REFUSAL = /image|imagem|modalit|multimodal|vision|inline_?data|content must be a string|not support/i;

/** Sonda um modelo e anota visão e disponibilidade na própria entrada. */
export async function probeVision(entry: CatalogEntry, lane: ProviderLane): Promise<void> {
  const image = await probeImage();
  for (let attempt = 0; ; attempt++) {
    const reply = await lane.run(entry.model, () => probeOnce(entry, image));
    if (reply.ok) {
      const read = reply.text.includes(PROBE_NUMBER);
      Object.assign(entry, { vision: read, visionSource: "sonda", availability: "ok",
        ...(read ? {} : { note: `aceitou a imagem, mas não leu o número (respondeu: ${safeMessage(reply.text).slice(0, 60)})` }) });
      return;
    }
    const action = failureAction({ provider: entry.provider, ...reply, attempt });
    if (action.action === "retry" && attempt < 2) { lane.defer(entry.model, Date.now() + action.waitMs); continue; }
    if (reply.status === 400 && IMAGE_REFUSAL.test(reply.message)) {
      Object.assign(entry, { vision: false, visionSource: "sonda", availability: "ok", note: `recusou imagem: ${safeMessage(reply.message).slice(0, 120)}` });
      return;
    }
    const detail = `HTTP ${reply.status || "—"} ${safeMessage(reply.message).slice(0, 160)}`;
    // Demanda alta e demora não tiram o modelo do teste: a rodada tenta de novo.
    if (action.action === "retry" || action.status === "timeout" || action.status === "indisponivel" || action.status === "erro_rede") {
      Object.assign(entry, { note: `sonda sem resposta (${reply.timedOut ? "timeout" : detail}); visão presumida pelo nome` });
      return;
    }
    if (action.status === "sem_cota") {
      Object.assign(entry, { availability: "sem_cota", note: action.action === "stop_model" && action.pending ? "cota do dia esgotada na sonda" : "sem cota no plano grátis (limite 0)" });
      return;
    }
    Object.assign(entry, { availability: "indisponivel", note: `sonda: ${detail}` });
    return;
  }
}
