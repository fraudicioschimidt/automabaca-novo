import { z } from "zod";
import { CAPTURE_STAKE_POLICIES } from "@/src/domain/capture-stake-policy";
import { marketKindOf, marketPeriodOf } from "@/src/domain/mercados/classify";
import { normalizeMercadoKey, resolveMercadoStatic } from "@/src/domain/mercados/catalog";
import { totalDirectionOf } from "@/src/domain/mercados/total-direction";
import { parseLineQuarters } from "@/src/domain/settlement/lines";
import { buildPlayerPropTerms, normalizePlayerThreshold } from "@/src/domain/settlement/player-prop-terms";
import { canonicalSport } from "@/src/domain/sports/registry";
import { normalizeStr, sameFixtureTeams, teamSimilarity } from "@/src/domain/text";

/** Odds iguais até a terceira casa decimal (1.849 × 1.8495). */
const oddsClose = (a: number, b: number): boolean => Math.abs(a - b) < 0.0005;

/*
 * Parte pura da bancada de leitura (`scripts/bench-leitura.ts`): o gabarito,
 * a comparação de cada leitura com ele e as métricas por modelo. Nada aqui
 * chama API ou lê disco, para o resultado poder ser recalculado depois de o
 * dono corrigir o gabarito, sem gastar cota de novo.
 */

const READERS = ["texto", "bilhete", "jogador", "album"] as const;
export type Reader = typeof READERS[number];
const ANSWER_KINDS = ["aposta", "nao_e_aposta", "incompleta"] as const;
export type AnswerKind = typeof ANSWER_KINDS[number];
export const BET_FIELDS = ["evento", "mercado", "selecao", "linha", "odds", "stake", "esporte"] as const;
export type BetField = typeof BET_FIELDS[number];

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"] as const;
export const isImageFile = (name: string) => IMAGE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
export const isCaptionFile = (name: string) => name.toLowerCase().endsWith(".legenda.txt");
export const isTextPostFile = (name: string) => name.toLowerCase().endsWith(".txt") && !isCaptionFile(name);

const expectedBetSchema = z.object({
  evento: z.string().trim().min(1),
  mercado: z.string().trim().optional(),
  selecao: z.string().trim().optional(),
  linha: z.number().nullable().optional(),
  odds: z.number().nullable().optional(),
  stake: z.number().nullable().optional(),
  esporte: z.string().trim().optional(),
});
export type ExpectedBet = z.infer<typeof expectedBetSchema>;

const entrySchema = z.object({
  arquivos: z.array(z.string().min(1)).min(1).max(10).optional(),
  legenda: z.string().optional(),
  leitor: z.enum(READERS).optional(),
  resposta: z.enum(ANSWER_KINDS).optional(),
  apostas: z.array(expectedBetSchema).default([]),
  faltando: z.array(z.string()).default([]),
  politica: z.enum(["AUTO", "CAPTION_ODD", "IMAGE_ODD"]).default("AUTO"),
  banca: z.object({
    stakePolicy: z.enum(CAPTURE_STAKE_POLICIES).optional(),
    defaultStakeUnits: z.number().nullable().optional(),
  }).optional(),
  dataPost: z.iso.datetime({ offset: true }).optional(),
  conferido: z.boolean().default(true),
  obs: z.string().optional(),
});

export type GabaritoItem = {
  id: string;
  arquivos: string[];
  legenda: string;
  leitor: Reader;
  resposta: AnswerKind;
  apostas: ExpectedBet[];
  faltando: string[];
  politica: "AUTO" | "CAPTION_ODD" | "IMAGE_ODD";
  banca?: { stakePolicy?: typeof CAPTURE_STAKE_POLICIES[number]; defaultStakeUnits?: number | null };
  dataPost?: string;
  conferido: boolean;
};

/**
 * Lê o gabarito: um objeto cujas chaves são o arquivo (ou um nome qualquer,
 * com `arquivos`). Chaves que começam com `_` são comentário. Devolve os itens
 * válidos e a lista de problemas, para o dono corrigir tudo de uma vez.
 */
export function parseGabarito(
  raw: unknown,
  folder: { exists: (name: string) => boolean; sidecarCaption: (name: string) => string | undefined },
): { items: GabaritoItem[]; problems: string[] } {
  const problems: string[] = [];
  const items: GabaritoItem[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { items, problems: ["o gabarito precisa ser um objeto { \"arquivo\": { ... } }"] };
  for (const [id, value] of Object.entries(raw)) {
    if (id.startsWith("_")) continue;
    const parsed = entrySchema.safeParse(value);
    if (!parsed.success) {
      problems.push(`${id}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "item"} ${issue.message}`).join("; ")}`);
      continue;
    }
    const entry = parsed.data;
    const arquivos = entry.arquivos ?? [id];
    const missingFiles = arquivos.filter((name) => !folder.exists(name));
    if (missingFiles.length) {
      problems.push(`${id}: arquivo não encontrado na pasta: ${missingFiles.join(", ")}`);
      continue;
    }
    const texts = arquivos.filter(isTextPostFile);
    const images = arquivos.filter(isImageFile);
    if (texts.length + images.length !== arquivos.length || (texts.length > 0 && arquivos.length > 1)) {
      problems.push(`${id}: use um .txt sozinho ou só imagens (.jpg, .png, .webp)`);
      continue;
    }
    const leitor: Reader = entry.leitor ?? (texts.length ? "texto" : images.length > 1 ? "album" : "bilhete");
    if ((leitor === "texto") !== (texts.length === 1)) {
      problems.push(`${id}: leitor "${leitor}" não combina com os arquivos`);
      continue;
    }
    if (leitor !== "album" && images.length > 1) {
      problems.push(`${id}: várias imagens só com leitor "album"`);
      continue;
    }
    const resposta = entry.resposta ?? (entry.apostas.length ? "aposta" : undefined);
    if (!resposta) {
      problems.push(`${id}: informe "apostas" ou "resposta" ("nao_e_aposta" ou "incompleta")`);
      continue;
    }
    if (resposta === "aposta" && !entry.apostas.length) {
      problems.push(`${id}: resposta "aposta" sem nenhuma aposta`);
      continue;
    }
    if (resposta === "nao_e_aposta" && entry.apostas.length) {
      problems.push(`${id}: "nao_e_aposta" não leva apostas`);
      continue;
    }
    const firstImage = images[0];
    items.push({
      id, arquivos, leitor, resposta,
      legenda: entry.legenda ?? (leitor !== "texto" && firstImage ? folder.sidecarCaption(firstImage) ?? "" : ""),
      apostas: entry.apostas, faltando: entry.faltando, politica: entry.politica,
      ...(entry.banca ? { banca: entry.banca } : {}),
      ...(entry.dataPost ? { dataPost: entry.dataPost } : {}),
      conferido: entry.conferido,
    });
  }
  return { items, problems };
}

/* Registro de cada tentativa (uma linha do JSONL). */

export type ReadBet = {
  evento: string;
  mercado: string;
  selecao: string;
  odds: number | null;
  stake: number | null;
  esporte: string;
};

/** O que a captura faria com esta leitura se este fosse o único modelo. */
export type AttemptOutcome = {
  kind: AnswerKind | "falha";
  /** Motivo legível: rascunho sem stake, revisão, recusa do porteiro etc. */
  detail: string;
  missing: string[];
  /** Apostas que seriam registradas (depois do porteiro da captura). */
  bets: ReadBet[];
  /** Linhas da leitura do modelo, para medir campo a campo mesmo sem aposta final. */
  readingRows: ReadBet[];
};

export type TransportStatus =
  | "ok" | "rate_limit" | "sem_cota" | "indisponivel" | "timeout" | "erro_http" | "modelo_indisponivel" | "erro_rede" | "credencial";

export type AttemptRecord = {
  key: string;
  itemId: string;
  itemHash: string;
  route: string;
  provider: string;
  model: string;
  endpoint: "generate" | "chat" | "ocr";
  rep: number;
  at: string;
  transport: TransportStatus;
  httpStatus?: number;
  error?: string;
  /** Duração da chamada que valeu, sem as esperas de cota. */
  latencyMs?: number;
  /** Tempo total da tentativa, com esperas e novas tentativas. */
  totalMs: number;
  httpAttempts: number;
  rateLimitHits: number;
  overProductionTimeout?: boolean;
  usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number; pages?: number };
  content?: "json" | "vazio" | "truncado" | "json_invalido";
  contractValid?: boolean;
  outcome?: AttemptOutcome;
  /** Impressão (sha256, 8 caracteres) da chave do Gemini que respondeu. */
  keyHint?: string;
  /** Cada chamada ao Gemini: a chave usada e o desfecho, para a disponibilidade por chave. */
  keyTrail?: Array<{ key: string; outcome: TransportStatus }>;
  /** JSON que o modelo devolveu (normalizado), para explicar a recusa. */
  reading?: unknown;
};

export const attemptKey = (itemId: string, itemHash: string, route: string, rep: number) => `${itemId}#${itemHash}|${route}|${rep}`;

/* Comparação campo a campo. */

const DIRECTION_WORDS = new Set(["over", "under", "mais", "menos", "acima", "abaixo", "o", "u", "de", "que"]);
// A estatística é conferida no mercado; na seleção só contam lado, direção e linha.
const STAT_WORDS = new Set([
  "gol", "gols", "goal", "goals", "escanteio", "escanteios", "corner", "corners", "cartao", "cartoes", "card", "cards",
  "ponto", "pontos", "point", "points", "game", "games", "set", "sets", "total", "totais", "asiatico", "asiaticos",
  "asian", "remate", "remates", "chute", "chutes", "shot", "shots", "alvo", "baliza", "target", "on", "no", "ao", "a",
  "do", "da", "the", "linha", "line", "handicap", "ah", "desarme", "desarmes", "tackle", "tackles", "rebote", "rebotes",
  "rebound", "rebounds", "assistencia", "assistencias", "assist", "assists", "passe", "passes", "falta", "faltas", "foul", "fouls",
  "marca", "marcar", "scorer", "anytime", "goalscorer", "sim", "yes", "vence", "vencer", "sem", "sofrer", "zero", "nil",
]);

function canonText(text: string): string {
  return normalizeStr(text).replace(/[−–—]/g, "-").replace(/(\d),(\d)/g, "$1.$2")
    .replace(/[^a-z0-9.+-]+/g, " ").replace(/\s+/g, " ").trim();
}

function selectionSubject(selecao: string): string {
  return canonText(normalizePlayerThreshold(selecao)).replace(/[+-]?\d+(?:\.\d+)?/g, " ").split(" ")
    .filter((token) => token && !/^[.+-]+$/.test(token) && !DIRECTION_WORDS.has(token) && !STAT_WORDS.has(token)).join(" ");
}

/** Linha da seleção pelo mesmo leitor de linhas da liquidação; null quando não há. */
export function lineOf(rawSelecao: string, mercado = ""): number | null {
  // "2+ desarmes" é pelo menos 2: a mesma leitura das props de jogador (Over 1.5).
  const selecao = normalizePlayerThreshold(rawSelecao);
  const quarters = parseLineQuarters(selecao, { allowNegative: marketKindOf(mercado, selecao) === "spread" || /[+-]\d/.test(selecao) });
  return quarters === null ? null : quarters / 4;
}

export function eventMatches(expected: string, actual: string): boolean {
  return canonText(expected) === canonText(actual) || sameFixtureTeams(expected, actual);
}

/** Mesmo lado (time ou jogador), mesma direção de total e mesma linha. */
export function selectionMatches(expected: string, actual: string, mercado = ""): boolean {
  if (canonText(expected) === canonText(actual)) return true;
  if (lineOf(expected, mercado) !== lineOf(actual, mercado)) return false;
  if (totalDirectionOf(normalizePlayerThreshold(expected)) !== totalDirectionOf(normalizePlayerThreshold(actual))) return false;
  const a = selectionSubject(expected), b = selectionSubject(actual);
  if (!a || !b) return a === b;
  return teamSimilarity(a, b) >= 0.85;
}

function statFamily(mercado: string): string {
  const key = normalizeMercadoKey(mercado);
  if (/escanteio|corner/.test(key)) return "corners";
  if (/cart[aoõ]|card|booking/.test(key)) return "cards";
  if (/desarme|tackle/.test(key)) return "tackles";
  if (/remate|chute|finaliza|shot/.test(key)) return /alvo|baliza|target|ao gol|no gol/.test(key) ? "shots_on_target" : "shots";
  if (/rebote|rebound/.test(key)) return "rebounds";
  if (/assist/.test(key)) return "assists";
  if (/ponto|point/.test(key)) return "points";
  if (/sem sofrer|to nil|clean sheet|de zero/.test(key)) return "win_to_nil";
  return "main";
}

const isPlayerMarket = (mercado: string) => /\b(?:jogador|player)\b/.test(normalizeMercadoKey(mercado));

/** Mesmo nome, mesmo mercado do catálogo do projeto, ou o mesmo tipo sobre a mesma estatística. */
export function marketMatches(expected: string, actual: string, selecao = ""): boolean {
  if (normalizeMercadoKey(expected) === normalizeMercadoKey(actual)) return true;
  const known = resolveMercadoStatic(expected);
  if (known && known === resolveMercadoStatic(actual)) return true;
  const props = [buildPlayerPropTerms({ mercado: expected, selecao }), buildPlayerPropTerms({ mercado: actual, selecao })];
  if (props[0] && props[1]) return props[0].family === props[1].family && props[0].period === props[1].period;
  // Nomes diferentes ("Total de Escanteios", "Total (Corners) – Match") ainda
  // podem ser o mesmo mercado: mesmo período, mesmo tipo, mesma estatística.
  if (marketPeriodOf(expected) !== marketPeriodOf(actual) || statFamily(expected) !== statFamily(actual)) return false;
  if (isPlayerMarket(expected) && isPlayerMarket(actual)) return true;
  const kind = marketKindOf(expected, selecao);
  return kind === marketKindOf(actual, selecao) && (kind !== "other" || statFamily(expected) !== "main");
}

/** "Futebol", "soccer" e "Soccer" são o mesmo esporte pelo registro do projeto. */
const sportKey = (sport: string) => canonicalSport(sport) ?? normalizeStr(sport);

const numberMatches = (expected: number | null, actual: number | null, close: (a: number, b: number) => boolean) =>
  expected === null ? actual === null || actual === 0 : actual !== null && close(expected, actual);

/** Campos conferidos de uma aposta; campo ausente no gabarito não conta. */
export function compareBet(expected: ExpectedBet, actual: ReadBet | undefined): Partial<Record<BetField, boolean>> {
  const result: Partial<Record<BetField, boolean>> = { evento: Boolean(actual && eventMatches(expected.evento, actual.evento)) };
  const mercado = expected.mercado ?? actual?.mercado ?? "";
  if (expected.mercado !== undefined) result.mercado = Boolean(actual && marketMatches(expected.mercado, actual.mercado, expected.selecao ?? ""));
  if (expected.selecao !== undefined) result.selecao = Boolean(actual && selectionMatches(expected.selecao, actual.selecao, mercado));
  const expectedLine = expected.linha !== undefined ? expected.linha : expected.selecao !== undefined ? lineOf(expected.selecao, mercado) : undefined;
  if (expectedLine !== undefined) result.linha = Boolean(actual) && lineOf(actual?.selecao ?? "", actual?.mercado ?? mercado) === expectedLine;
  if (expected.odds !== undefined) result.odds = Boolean(actual) && numberMatches(expected.odds, actual?.odds ?? null, oddsClose);
  if (expected.stake !== undefined) result.stake = Boolean(actual) && numberMatches(expected.stake, actual?.stake ?? null, (a, b) => Math.abs(a - b) < 1e-6);
  if (expected.esporte) result.esporte = Boolean(actual) && sportKey(expected.esporte) === sportKey(actual?.esporte ?? "");
  return result;
}

/** Esporte não informado ("Unknown") é resolvido depois pela captura e não
 * derruba a aposta inteira; esporte errado derruba. O campo segue contado. */
const fullyCorrect = (fields: Partial<Record<BetField, boolean>>, actual?: ReadBet) => Object.entries(fields)
  .every(([field, ok]) => ok || (field === "esporte" && actual !== undefined && !canonicalSport(actual.esporte)));
const correctCount = (fields: Partial<Record<BetField, boolean>>) => Object.values(fields).filter(Boolean).length;

/** Pareia as apostas do gabarito com as lidas, sem depender da ordem. */
export function matchBets(expected: readonly ExpectedBet[], actual: readonly ReadBet[]): Array<{ expected: ExpectedBet; actual?: ReadBet; fields: Partial<Record<BetField, boolean>> }> {
  const free = new Set(actual.map((_, index) => index));
  return expected.map((bet) => {
    let best: { index: number; fields: Partial<Record<BetField, boolean>>; score: number } | undefined;
    for (const index of free) {
      const fields = compareBet(bet, actual[index]);
      const score = correctCount(fields) + (fields.evento ? 0.5 : 0);
      if (!best || score > best.score) best = { index, fields, score };
    }
    if (!best) return { expected: bet, fields: compareBet(bet, undefined) };
    free.delete(best.index);
    return { expected: bet, actual: actual[best.index], fields: best.fields };
  });
}

export type AttemptScore = {
  predictedKind: AttemptOutcome["kind"];
  kindCorrect: boolean;
  missingCorrect?: boolean;
  itemCorrect: boolean;
  fields: Partial<Record<BetField, boolean>>[];
  betsCorrect: number;
  betsTotal: number;
  errors: string[];
};

const describe = (bet?: ReadBet) => bet
  ? `${bet.evento} | ${bet.mercado} | ${bet.selecao} @ ${bet.odds ?? "—"} · ${bet.stake ?? "—"}u · ${bet.esporte || "—"}`
  : "nenhuma aposta correspondente";

/** Nota de uma leitura que chegou ao contrato; null quando não houve resposta. */
export function scoreAttempt(record: AttemptRecord, item: GabaritoItem): AttemptScore | null {
  if (record.transport !== "ok" || !record.outcome) return null;
  const outcome = record.outcome;
  const kindCorrect = outcome.kind === item.resposta;
  const rows = outcome.kind === "aposta" ? outcome.bets : outcome.readingRows;
  const matched = matchBets(item.apostas, rows);
  const betsCorrect = matched.filter((match) => fullyCorrect(match.fields, match.actual)).length;
  const errors: string[] = [];
  if (!kindCorrect) errors.push(`esperado ${item.resposta}, leu ${outcome.kind} (${outcome.detail})`);
  if (outcome.kind === "falha" && record.reading !== undefined) errors.push(`resposta do modelo: ${JSON.stringify(record.reading).slice(0, 400)}`);
  for (const match of matched) {
    const wrong = BET_FIELDS.filter((field) => match.fields[field] === false);
    if (wrong.length) errors.push(`${wrong.join(", ")} errado: esperado ${match.expected.evento} | ${match.expected.mercado ?? "?"} | ${match.expected.selecao ?? "?"} @ ${match.expected.odds ?? "—"} · ${match.expected.stake ?? "—"}u; leu ${describe(match.actual)}`);
  }
  const countCorrect = outcome.kind !== "aposta" || outcome.bets.length === item.apostas.length;
  if (item.resposta === "aposta" && outcome.kind === "aposta" && !countCorrect) {
    errors.push(`esperado ${item.apostas.length} aposta(s), leu ${outcome.bets.length}`);
  }
  const missingCorrect = item.resposta === "incompleta" && item.faltando.length
    ? outcome.kind === "incompleta" && item.faltando.every((field) => outcome.missing.includes(field))
    : undefined;
  const itemCorrect = kindCorrect && (item.resposta !== "aposta" || (countCorrect && betsCorrect === item.apostas.length));
  return {
    predictedKind: outcome.kind, kindCorrect, ...(missingCorrect !== undefined ? { missingCorrect } : {}),
    itemCorrect, fields: matched.map((match) => match.fields), betsCorrect, betsTotal: item.apostas.length, errors,
  };
}

/* Métricas por modelo. */

/** Percentil com interpolação linear entre as posições vizinhas; null sem amostras. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, p / 100));
  const lower = Math.floor(position), upper = Math.ceil(position);
  const low = sorted[lower] ?? 0, high = sorted[upper] ?? low;
  return low + (high - low) * (position - lower);
}

export type Ratio = { correct: number; total: number };
const ratio = (): Ratio => ({ correct: 0, total: 0 });
export const rate = (value: Ratio) => (value.total ? value.correct / value.total : null);

export type RouteSummary = {
  route: string;
  provider: string;
  model: string;
  endpoint: string;
  vision: boolean;
  inUse: boolean;
  planned: number;
  /** Leituras do plano com algum registro, em qualquer passada. */
  recorded: number;
  pending: number;
  /** Leituras que chegaram ao contrato (a última resposta de cada uma). */
  answered: number;
  contractValid: number;
  /** Tentativas de todas as passadas, por desfecho de transporte: é a disponibilidade. */
  attempts: number;
  transport: Partial<Record<TransportStatus, number>>;
  rateLimitHits: number;
  item: Ratio;
  /** Acerto só nos itens que algum modelo acertou: tira o que a captura recusa para todos. */
  achievable: Ratio;
  text: Ratio;
  image: Ratio;
  kinds: Record<AnswerKind, Ratio>;
  missing: Ratio;
  fields: Record<BetField, Ratio>;
  bets: Ratio;
  latency: { p50: number | null; p95: number | null; mean: number | null };
  overProductionTimeout: number;
  tokens: { input: number | null; output: number | null; pages: number | null };
  lastTransport?: TransportStatus;
  lastError?: string;
  errors: Array<{ itemId: string; rep: number; lines: string[] }>;
  /** Por impressão de chave do Gemini: chamadas e desfechos, de todas as passadas. */
  keys: Record<string, Partial<Record<TransportStatus, number>>>;
};

export type PlanRoute = { route: string; provider: string; model: string; endpoint: string; vision: boolean; inUse: boolean; keys: string[] };

const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

/** A leitura que vale para cada chave: a última que respondeu; sem resposta, a última tentativa. */
export function latestAttempts(records: readonly AttemptRecord[]): Map<string, AttemptRecord> {
  const latest = new Map<string, AttemptRecord>();
  for (const record of records) {
    const current = latest.get(record.key);
    if (!current || record.transport === "ok" || current.transport !== "ok") latest.set(record.key, record);
  }
  return latest;
}

/** Itens que ao menos um modelo acertou em alguma leitura. */
export function achievableItems(records: readonly AttemptRecord[], items: ReadonlyMap<string, GabaritoItem>): Set<string> {
  const ids = new Set<string>();
  for (const record of latestAttempts(records).values()) {
    const item = items.get(record.itemId);
    if (item && scoreAttempt(record, item)?.itemCorrect) ids.add(record.itemId);
  }
  return ids;
}

export function summarizeRoute(plan: PlanRoute, records: readonly AttemptRecord[], items: ReadonlyMap<string, GabaritoItem>,
  achievable: ReadonlySet<string> = new Set(items.keys())): RouteSummary {
  const planned = new Set(plan.keys);
  const history = records.filter((record) => record.route === plan.route && planned.has(record.key));
  const own = [...latestAttempts(history).values()];
  const latencies: number[] = [], inputs: number[] = [], outputs: number[] = [], pages: number[] = [];
  const summary: RouteSummary = {
    route: plan.route, provider: plan.provider, model: plan.model, endpoint: plan.endpoint, vision: plan.vision, inUse: plan.inUse,
    planned: planned.size, recorded: own.length, pending: planned.size - own.length, answered: 0, contractValid: 0,
    attempts: history.length, transport: {}, rateLimitHits: 0, item: ratio(), achievable: ratio(), text: ratio(), image: ratio(),
    kinds: { aposta: ratio(), nao_e_aposta: ratio(), incompleta: ratio() }, missing: ratio(),
    fields: Object.fromEntries(BET_FIELDS.map((field) => [field, ratio()])) as Record<BetField, Ratio>,
    bets: ratio(), latency: { p50: null, p95: null, mean: null }, overProductionTimeout: 0,
    tokens: { input: null, output: null, pages: null }, errors: [], keys: {},
  };
  for (const record of history) {
    for (const call of record.keyTrail ?? []) {
      const byKey = summary.keys[call.key] ?? {};
      byKey[call.outcome] = (byKey[call.outcome] ?? 0) + 1;
      summary.keys[call.key] = byKey;
    }
    summary.transport[record.transport] = (summary.transport[record.transport] ?? 0) + 1;
    summary.rateLimitHits += record.rateLimitHits;
    summary.lastTransport = record.transport;
    if (record.transport !== "ok") summary.lastError = record.error;
  }
  for (const record of own) {
    const item = items.get(record.itemId);
    const score = item ? scoreAttempt(record, item) : null;
    if (record.transport === "ok") {
      if (record.latencyMs !== undefined) latencies.push(record.latencyMs);
      if (record.overProductionTimeout) summary.overProductionTimeout += 1;
      if (record.usage?.inputTokens !== undefined) inputs.push(record.usage.inputTokens);
      if (record.usage?.outputTokens !== undefined) outputs.push(record.usage.outputTokens);
      if (record.usage?.pages !== undefined) pages.push(record.usage.pages);
    }
    if (!score || !item) continue;
    summary.answered += 1;
    if (record.contractValid) summary.contractValid += 1;
    const bump = (target: Ratio, ok: boolean) => { target.total += 1; if (ok) target.correct += 1; };
    bump(summary.item, score.itemCorrect);
    if (achievable.has(item.id)) bump(summary.achievable, score.itemCorrect);
    bump(item.leitor === "texto" ? summary.text : summary.image, score.itemCorrect);
    bump(summary.kinds[item.resposta], score.kindCorrect);
    if (score.missingCorrect !== undefined) bump(summary.missing, score.missingCorrect);
    for (const fields of score.fields) {
      for (const field of BET_FIELDS) if (fields[field] !== undefined) bump(summary.fields[field], fields[field] === true);
    }
    summary.bets.correct += score.betsCorrect;
    summary.bets.total += score.betsTotal;
    if (score.errors.length) summary.errors.push({ itemId: record.itemId, rep: record.rep, lines: score.errors });
  }
  summary.latency = { p50: percentile(latencies, 50), p95: percentile(latencies, 95), mean: mean(latencies) };
  summary.tokens = { input: mean(inputs), output: mean(outputs), pages: mean(pages) };
  return summary;
}

/**
 * A conta do relatório: o ranking dos modelos e o acerto de cada item.
 * `routes` já vem só com as chaves que valem (item atual, modelo no catálogo),
 * e só as leituras delas contam: a de uma versão antiga do item leu outra
 * entrada e não pode torná-lo alcançável nem somar na tabela por item.
 */
export function summarizeRun(routes: readonly PlanRoute[], records: readonly AttemptRecord[], items: readonly GabaritoItem[]) {
  const planned = new Set(routes.flatMap((route) => route.keys));
  const counted = records.filter((record) => planned.has(record.key));
  const byId = new Map(items.map((item) => [item.id, item]));
  const achievable = achievableItems(counted, byId);
  const summaries = rankRoutes(routes.map((route) => summarizeRoute(route, counted, byId, achievable)));
  const latest = [...latestAttempts(counted).values()].filter((record) => record.transport === "ok");
  const itemStats = items.map((item) => {
    const own = latest.filter((record) => record.itemId === item.id);
    const misses = own.filter((record) => !scoreAttempt(record, item)?.itemCorrect).map((record) => record.outcome?.detail ?? "?");
    const tally = new Map<string, number>();
    for (const miss of misses) tally.set(miss, (tally.get(miss) ?? 0) + 1);
    const commonMiss = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    return { id: item.id, correct: own.length - misses.length, answered: own.length,
      ...(commonMiss ? { commonMiss: `${commonMiss[0]} (${commonMiss[1]})` } : {}) };
  });
  return { summaries, itemStats };
}

/** Amostra mínima de respostas para o modelo disputar o ranking. */
const MIN_ANSWERED_SHARE = 0.5;
export const hasEnoughSample = (summary: RouteSummary) => summary.planned > 0 && summary.answered / summary.planned >= MIN_ANSWERED_SHARE;

/** Ranking: amostra suficiente primeiro, depois acerto do item inteiro e, no empate, o p50 mais rápido. */
export function rankRoutes(summaries: readonly RouteSummary[]): RouteSummary[] {
  return [...summaries].sort((a, b) => Number(hasEnoughSample(b)) - Number(hasEnoughSample(a))
    || (rate(b.item) ?? -1) - (rate(a.item) ?? -1)
    || (a.latency.p50 ?? Infinity) - (b.latency.p50 ?? Infinity)
    || a.route.localeCompare(b.route));
}

/* Proposta da rodada: o dono decide, a página só aponta. Disponibilidade de
 * uma janela não elimina ninguém: 503, timeout e 429 mandam reconfirmar. */

const RULES = {
  /** Acerto nos itens alcançáveis abaixo disto elimina, com ao menos minAnswers respostas. */
  minAchievableAccuracy: 0.6,
  /** Respostas fora do contrato da extração acima de 20% eliminam. */
  minContractShare: 0.8,
  /** Respostas acima do prazo de produção em 20%+ das leituras eliminam (lentidão consistente). */
  maxOverTimeoutShare: 0.2,
  minAnswers: 5,
  /** Abaixo disto de tentativas respondidas, o modelo volta para reconfirmar. */
  minAvailability: 0.5,
} as const;

export type Verdict = { verdict: "manter" | "eliminar" | "reconfirmar" | "sem_acesso"; reasons: string[] };

export function routeVerdict(summary: RouteSummary, productionTimeoutMs: number): Verdict {
  const count = (status: TransportStatus) => summary.transport[status] ?? 0;
  if (summary.answered === 0 && (count("modelo_indisponivel") || count("sem_cota") || count("credencial"))) {
    return { verdict: "sem_acesso", reasons: [summary.lastError ? `sem acesso nesta chave: ${summary.lastError.slice(0, 140)}` : "sem acesso nesta chave"] };
  }
  const eliminate: string[] = [];
  if (summary.answered >= RULES.minAnswers) {
    const accuracy = rate(summary.achievable) ?? 0;
    if (accuracy < RULES.minAchievableAccuracy) eliminate.push(`acerto baixo (${Math.round(accuracy * 100)}% nos itens que algum modelo acertou)`);
    const contract = summary.contractValid / summary.answered;
    if (contract < RULES.minContractShare) eliminate.push(`contrato inválido em ${Math.round((1 - contract) * 100)}% das respostas`);
    if (summary.overProductionTimeout / summary.answered >= RULES.maxOverTimeoutShare) {
      eliminate.push(`lento (${summary.overProductionTimeout} de ${summary.answered} acima do prazo de ${productionTimeoutMs / 1000} s; p50 ${((summary.latency.p50 ?? 0) / 1000).toFixed(1)} s)`);
    }
  }
  if (eliminate.length) return { verdict: "eliminar", reasons: eliminate };
  const reconfirm: string[] = [];
  const unavailable = count("indisponivel") + count("timeout") + count("erro_rede");
  if (summary.attempts && (count("ok") / summary.attempts) < RULES.minAvailability) {
    reconfirm.push(`respondeu ${count("ok")} de ${summary.attempts} tentativas (${unavailable} 503/timeout, ${count("rate_limit")} 429)`);
  }
  if (summary.answered < RULES.minAnswers || !hasEnoughSample(summary)) {
    reconfirm.push(`amostra curta: ${summary.answered}/${summary.planned} respondidas${summary.pending ? `, ${summary.pending} pendentes de cota` : ""}`);
  }
  return reconfirm.length ? { verdict: "reconfirmar", reasons: reconfirm } : { verdict: "manter", reasons: [] };
}
