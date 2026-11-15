import { z } from "zod";
import { parseStoredLegs, type BetLegsTicket } from "@/src/domain/bet-legs";
import { selecaoPareceTotal } from "@/src/domain/mercados/selection-shape";
import { parseLineQuarters } from "@/src/domain/settlement/lines";
import { playerPropInputSchema } from "@/src/domain/settlement/player-prop-terms";
import type { SportResolutionDecision } from "@/src/domain/sports/detect";
import { CANONICAL_SPORTS, type CanonicalSport } from "@/src/domain/sports/registry";
import { normalizeStr, splitEventoTeams } from "@/src/domain/text";
import type { CaptureOcrEvidence } from "./capture-ocr-evidence";
import type { CaptureStakeSnapshot } from "./capture-stake-policy";

const FREE_STAKE_TERMS = String.raw`(?:free\s*bets?|bonus\s*bets?|apostas?\s+(?:gratis|gratuitas?))`;
const FREE_STAKE_NOT_APPLIED = String.raw`(?!\s+(?:disponive\w*|nao\s+(?:usad\w*|aplicad\w*|utilizad\w*)))`;
const PROMOTION_FUNDING_LABEL = new RegExp(String.raw`^(?:(?:tipo|aposta|entrada|stake|pagamento)\s*[:=]\s*)?${FREE_STAKE_TERMS}\b${FREE_STAKE_NOT_APPLIED}`);
const USED_PROMOTION_FUNDING = new RegExp(String.raw`\b(?:com|usando|utilizando|em)\s+(?:(?:uma?|saldo|credito|dinheiro)\s+(?:de\s+)?)?${FREE_STAKE_TERMS}\b`);
const REFUND_ON_LOSS = String.raw`(?:reembols\w*|devolvid[ao]s?)\b.{0,40}\b(?:perder|perca|derrota|(?:se|caso)\s+(?!empatar\b|empate\b)\w+)\b`;

const financialLines = (text: string | null | undefined, kept: string): string[] =>
  (text ?? "").split(/[\n;•]/).map((line) =>
    normalizeStr(line).replace(new RegExp(`[^a-z0-9${kept} ]`, "g"), " ").replace(/\s+/g, " ").trim());

/** Devolução que o próprio mercado prevê (empate anula, jogador não atuou) não é promoção. */
const isNativeRefund = (terms: string): boolean =>
  /\b(?:empatar|empate|nao (?:jogar|entrar|participar|atuar))\b/.test(terms) && !/\b(?:perder|perca|derrota)\b/.test(terms);

/**
 * Estes termos mudam a perda, o pagamento ou a natureza da stake. Sem um
 * contrato financeiro que os represente, o placar não basta para calcular
 * lucro. Oferta de cadastro e odd turbinada efetiva não mudam esse contrato.
 * Vale para os termos da aposta (mercado, seleção, pernas) e para o trecho
 * que o leitor aponta como prova; a legenda livre passa por
 * `captionDeclaresPromotionFunding`.
 */
export function hasUnsupportedPromotionTerms(...texts: Array<string | null | undefined>): boolean {
  return texts.some((text) => financialLines(text, ":=").some((terms) => {
    // Publicidade de uma recompensa futura não prova que ela pagou esta tip.
    if (/^(?:ganhe|receba|cadastre|use (?:o )?cupom)\b/.test(terms)) return false;
    if (/^(?:sem\s+pagamento antecipado|pagamento antecipado\s+(?:nao\s+aplicado|desativado))\b/.test(terms)) return false;
    return PROMOTION_FUNDING_LABEL.test(terms) || USED_PROMOTION_FUNDING.test(terms)
      || /\b(?:stake|aposta|entrada)\s+(?:em|com|usando)\s+(?:saldo de )?bonus\b/.test(terms)
      || /\bapostas?\s+(?:sem risco|protegidas?)\b/.test(terms)
      || (!isNativeRefund(terms) && new RegExp(String.raw`\b${REFUND_ON_LOSS}`).test(terms))
      || /\bpagamento antecipado\b|\bearly payout\b/.test(terms);
  }));
}

const FUNDING_LABEL = String.raw`(?:(?:tipo|aposta|entrada|stake|pagamento|financiamento)\s*[:=]\s*)?`;
const FUNDED_BET = String.raw`(?:aposta|entrada|stake|bilhete)\s+(?:(?:feita|realizada|paga)\s+)?(?:em|com|usando|utilizando)\s+(?:(?:uma?|saldo|credito|dinheiro)\s+(?:de\s+)?)?(?:${FREE_STAKE_TERMS}|bonus)\b`;
const CAPTION_PROMOTION_FUNDING = new RegExp(String.raw`^${FUNDING_LABEL}(?:${FREE_STAKE_TERMS}\b${FREE_STAKE_NOT_APPLIED}|${FUNDED_BET}`
  + String.raw`|(?:feita\s+)?(?:com|usando|utilizando)\s+(?:uma?\s+)?${FREE_STAKE_TERMS}\b|apostas?\s+(?:sem risco|protegidas?)\b`
  + String.raw`|(?:pagamento antecipado|early payout)\b(?!\s+(?:nao\s+aplicado|desativado)))`);
const CAPTION_REFUND_ON_LOSS = new RegExp(String.raw`^${FUNDING_LABEL}(?:aposta\s+)?${REFUND_ON_LOSS}`);
/** Linha de divulgação: fala da oferta da casa, não do financiamento desta aposta. */
const ADVERTISING_LINE = /\b(?:ganh[ea]|receba|cadastr\w*|deposit\w*|cupom|codigo|link|novos clientes|boas vindas)\b/;

/**
 * A legenda é texto livre: rodapé de afiliado e selo da casa ("bet365 -
 * Pagamento Antecipado") citam os mesmos termos sem falar desta aposta. Nela
 * só vale a linha que começa rotulando o financiamento ("Tipo: aposta
 * grátis", "Aposta feita com free bet", "Reembolsada se perder").
 */
export function captionDeclaresPromotionFunding(caption: string | null | undefined): boolean {
  return financialLines(caption, ":=").some((terms) => !ADVERTISING_LINE.test(terms)
    && (CAPTION_PROMOTION_FUNDING.test(terms) || (!isNativeRefund(terms) && CAPTION_REFUND_ON_LOSS.test(terms))));
}

const LAY_NOT_APPLIED = /^(?:sem lay|lay (?:nao (?:usado|utilizado|aplicado)|desativado))\b/;
const COMMISSION_CHARGED = /^(?:comissao|commission)\s*[:=]\s*(?:[1-9]\d*(?:[.,]\d+)?|0[.,]\d*[1-9]\d*)\s*%/;
const isPartialCashout = (terms: string): boolean =>
  /\bcash\s*out\s+parcial\b|\bpartial\s+cash\s*out\b/.test(terms)
  && !/\bcash\s*out\s+parcial\s+(?:aos?|se|caso|quando|antes|ate|disponivel|oferecido)\b/.test(terms);

/** Lay precisa de responsabilidade e comissão; encerramento parcial mantém
 * exposição aberta. Nenhum deles cabe no contrato de uma aposta a favor.
 * Vale para os termos da aposta e para a prova do leitor; a legenda livre
 * passa por `captionDeclaresTradingOperation`. */
export function hasUnsupportedTradingTerms(...texts: Array<string | null | undefined>): boolean {
  return texts.some((text) => financialLines(text, ":=.,%").some((terms) => {
    if (LAY_NOT_APPLIED.test(terms)) return false;
    return /\blay\b(?!\s+ups?\b)/.test(terms)
      || /\b(?:aposta|apostar|entrada|operacao)\s+contra\b/.test(terms)
      || /^(?:contra|responsabilidade|liability)\s*(?:[:=]|\s)\s*\S/.test(terms)
      || COMMISSION_CHARGED.test(terms)
      || isPartialCashout(terms);
  }));
}

const CAPTION_TRADING_OPERATION = new RegExp(String.raw`^(?:(?:(?:tipo|operacao|aposta|entrada|mercado)\s*[:=]?\s*)?lay\b(?!\s+ups?\b)`
  + String.raw`|(?:aposta|apostar|entrada|operacao)\s+contra\b|contra\s*[:=]`
  + String.raw`|(?:responsabilidade|liability)\s*[:=]?\s*(?:r\s*)?\d)`);

/**
 * Na legenda livre, "contra", "responsabilidade" e "lay" aparecem em frase
 * comum ("Contra tudo e contra todos", "Responsabilidade sempre", "lay-up").
 * Só vale a linha que começa rotulando a operação desta aposta ("Lay Flamengo
 * @2.0", "Responsabilidade: 50", "Comissão: 5%") ou o cash-out parcial feito.
 */
export function captionDeclaresTradingOperation(caption: string | null | undefined): boolean {
  return financialLines(caption, ":=.,%").some((terms) => !LAY_NOT_APPLIED.test(terms)
    && (CAPTION_TRADING_OPERATION.test(terms) || COMMISSION_CHARGED.test(terms) || isPartialCashout(terms)));
}

/** Imagem da captura já baixada (base64 + mime), pronta para a leitura por visão. */
export type CaptureImage = { base64: string; mimeType: string };

/** Contrato canônico entre parsers, canais de entrada e serviços de captura. */
export type ParsedBetPost = {
  ocrEvidence?: import("./capture-ocr-evidence").CaptureOcrEvidence;
  stakePolicySnapshot?: CaptureStakeSnapshot;
  playerProp?: import("./settlement/player-prop-terms").PlayerPropInput;
  stakeSource?: "caption" | "image_units" | "unknown";
  evento: string;
  esporte: string;
  competicao: string;
  pais: string;
  mercado: string;
  selecao: string;
  /** Placar no instante da tip live, na ordem mandante/visitante. Sempre pareado. */
  liveScoreHome?: number;
  liveScoreAway?: number;
  /** Source excerpt supporting the score after selection normalization. */
  liveScoreEvidence?: string;
  odds: number;
  stake: number;
  /** Kickoff em UTC; null = origem sem data (o caller decide o default). */
  data: Date | null;
  /** true = o parser encontrou somente o dia, sem hora explícita. */
  kickoffDateOnly?: boolean;
  casaDeAposta: string;
  /** Os parsers sempre preenchem; o rascunho de DM guarda só o esporte textual. */
  sportResolution?: SportResolutionDecision;
  /** Dupla/tripla/SGP: um ticket, N pernas. Ausente = aposta simples. */
  legs?: BetLegsTicket;
  /** O post não disse a unidade do total: escanteios foi deduzido pela linha. */
  totalUnitFromLine?: true;
};

/** Aposta capturada que passou pelo guard, com o esporte decidido. */
export type ResolvedCaptureBet = ParsedBetPost & { sportResolution: SportResolutionDecision };

/**
 * Os termos como foram lidos: a edição do post e a reentrega de um lote
 * comparam com eles, e nenhuma aposta capturada é gravada sem eles.
 */
export const capturedTermsSchema = z.object({
  evento: z.string().min(1),
  mercado: z.string().min(1),
  selecao: z.string().min(1),
  odds: z.number(),
  stake: z.number(),
});

const liveScoreAtTipSchema = z.number().int().nonnegative().nullable();

/** Quem leu a aposta e o que o registro normalizou nela (`captureRegisteredOcrEvidence`). */
const ocrEvidenceSchema = z.object({
  version: z.literal(1),
  state: z.enum(["complete", "draft", "review", "not_bet"]),
  accuracy: z.literal("unreviewed"),
  readers: z.array(z.looseObject({ provider: z.enum(["gemini", "groq", "mistral"]), model: z.string(), endpoint: z.string() })),
  sourceFields: z.record(z.string(), z.unknown()),
  transformations: z.array(z.string()),
  itemIndex: z.number().int().nonnegative().optional(),
  registration: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional(),
});

/**
 * A aposta lida, como a captura a grava em `bet_capture_evidence.parsedJson`
 * por qualquer caminho (post do canal, item de lote, conserto pela DM, DM).
 * A gravação só avisa no log quando a evidência sai deste contrato: a aposta
 * nunca deixa de ser registrada por causa dele. `forcedByOperator` também é
 * lido em SQL (latência do post no painel), por isso fica no topo e só existe
 * como `true`.
 */
export const captureParsedSchema = capturedTermsSchema.extend({
  esporte: z.string(),
  competicao: z.string(),
  pais: z.string(),
  casaDeAposta: z.string(),
  data: z.iso.datetime().nullable(),
  kickoffDateOnly: z.boolean(),
  liveScoreHome: liveScoreAtTipSchema,
  liveScoreAway: liveScoreAtTipSchema,
  liveScoreEvidence: z.string().optional(),
  sportResolution: z.object({
    sport: z.enum(CANONICAL_SPORTS as [CanonicalSport, ...CanonicalSport[]]).nullable(),
    status: z.enum(["CONFIRMED", "PENDING", "CONFLICT"]),
    confidence: z.number(),
    source: z.string(),
    evidence: z.array(z.object({ source: z.string(), sport: z.string(), confidence: z.number(), value: z.string() })),
    resolverVersion: z.number().int(),
  }),
  stakeSource: z.enum(["caption", "image_units", "unknown"]).optional(),
  stakePolicySnapshot: z.object({
    version: z.literal(1),
    stakePolicy: z.string(),
    source: z.string(),
    defaultStakeUnits: z.number().nullable(),
    originalStake: z.number().nullable(),
  }).optional(),
  playerProp: playerPropInputSchema.optional(),
  legs: z.custom<BetLegsTicket>((value) => parseStoredLegs(value) !== null).optional(),
  ocrEvidence: ocrEvidenceSchema.optional(),
  mediaFileIds: z.array(z.string().min(1)).optional(),
  forcedByOperator: z.literal(true).optional(),
  totalUnitFromLine: z.literal(true).optional(),
});

/** Limites compartilhados; parser e persistência validam a mesma política. */
export const MAX_ODDS = 1000;
export const MAX_STAKE_UNIDADES = 1000;
export const KICKOFF_WINDOW_DAYS = 400;
/**
 * Teto de PLAUSIBILIDADE da captura AUTOMÁTICA (canal/DM), mais estreito que o
 * teto de sanidade da persistência: tipsters operam em 0,25–10u; uma "stake
 * 500" é quase sempre OCR/LLM lendo VALOR EM MOEDA (R$ 500) como unidades — e
 * uma unidade errada move o ledger inteiro. Acima disto a
 * captura recusa para revisão; o painel (validação humana) continua aceitando
 * até MAX_STAKE_UNIDADES.
 */
export const MAX_STAKE_UNIDADES_CAPTURA = 100;

/**
 * Stake que a leitura AUTOMÁTICA aceita do post. Tipsters operam em
 * 0,25–10u; acima de 20u é quase sempre dinheiro ou meta lidos como unidades.
 * A stake definida pela banca e o painel não passam por este teto.
 */
export const MAX_AUTO_CAPTURE_STAKE_UNITS = 20;

/**
 * Odd que a leitura automática aceita nos mercados de placar simples
 * (vencedor, total, handicap, ambas marcam). "@185" é 1,85 sem o ponto.
 */
export const MAX_AUTO_CAPTURE_ODDS = 20;

/** Como a aposta foi lida, pelo `parser` gravado na evidência da captura. */
export type CaptureReading = "regra" | "ia_texto" | "ia_imagem" | "conversa";

/**
 * `universal` é o leitor por regra, local; `telegram-dm` é a conversa com o
 * bot; o resto é um provedor de IA, com `-vision` quando leu a imagem.
 */
export function captureReadingOf(parser: string): CaptureReading {
  if (parser === "universal") return "regra";
  if (parser === "telegram-dm") return "conversa";
  return parser.endsWith("-vision") ? "ia_imagem" : "ia_texto";
}

/**
 * Quem leu a aposta capturada: o leitor por regra ou um modelo de IA, com o
 * endpoint e a versão do contrato de extração. Vive na própria aposta, porque
 * a evidência da captura expira antes de a correção do dono medir o acerto.
 */
export type CaptureReader =
  | { kind: "rule" }
  | { kind: "llm"; provider: string; model: string | null; endpoint: string | null; contractVersion: string | null };

/**
 * O leitor pelo `parser` gravado e pela leitura que originou a aposta. A DM
 * não tem leitor: o dono confere a prévia antes de gravar.
 */
export function captureReaderOf(parser: string, parsed: unknown): CaptureReader | null {
  const reading = captureReadingOf(parser);
  if (reading === "regra") return { kind: "rule" };
  if (reading === "conversa") return null;
  const evidence = parsed && typeof parsed === "object" ? (parsed as { ocrEvidence?: CaptureOcrEvidence }).ocrEvidence : undefined;
  const reader = Array.isArray(evidence?.readers) ? evidence.readers[0] : undefined;
  return {
    kind: "llm",
    provider: reader?.provider ?? parser.replace(/-vision$/, ""),
    model: reader?.model ?? null,
    endpoint: reader?.endpoint ?? null,
    contractVersion: reader?.contractVersion ?? null,
  };
}

/** Ação de auditoria que liga a correção do dono ao leitor da captura. */
export const READING_CORRECTED_ACTION = "capture.reading_corrected";

/** Campos da leitura que a correção do dono mede, um a um. */
export const READING_FIELDS = ["evento", "mercado", "selecao", "linha", "odds", "stake"] as const;
export type ReadingField = (typeof READING_FIELDS)[number];

type ReadingTerms = { evento: string; mercado: string; selecao: string; odds: number; stake: number };

const LINE_NUMBER = /[+-]?\d+(?:[.,]\d+)?/g;
const textKey = (value: string) => normalizeStr(value).replace(/\s+/g, " ");
/** A seleção sem a linha: só as palavras, sem número, sinal nem separador de split. */
const selectionWords = (selecao: string) => textKey(selecao.replace(LINE_NUMBER, " ").replace(/[^\p{L}]+/gu, " "));
/**
 * A linha pelo valor em quartos: "+0.25" e "0/+0.5" são a mesma linha. O nome
 * dos times sai antes, para o dígito de "Vointa 2024" não virar linha.
 */
function lineKey(selecao: string, evento: string): number | null {
  const teams = splitEventoTeams(evento);
  let rest = normalizeStr(selecao);
  for (const team of teams ? [teams.home, teams.away] : []) {
    const name = normalizeStr(team);
    if (/\d/.test(name)) rest = rest.split(name).join(" ");
  }
  return parseLineQuarters(rest, { allowNegative: !selecaoPareceTotal(rest) });
}

/**
 * Campos que mudaram entre a aposta lida e a editada. Caixa, acento e espaço
 * não contam como correção. A linha é o número da seleção ("Over 2.5",
 * "Flamengo -1"), comparado em quartos: trocar só ela é erro de linha, não de
 * seleção, e reescrever a mesma linha ("0/+0.5" por "+0.25") não é erro.
 */
export function correctedReadingFields(before: ReadingTerms, after: ReadingTerms): ReadingField[] {
  const changed: Record<ReadingField, boolean> = {
    evento: textKey(before.evento) !== textKey(after.evento),
    mercado: textKey(before.mercado) !== textKey(after.mercado),
    selecao: selectionWords(before.selecao) !== selectionWords(after.selecao),
    linha: lineKey(before.selecao, before.evento) !== lineKey(after.selecao, after.evento),
    odds: Math.round(before.odds * 10_000) !== Math.round(after.odds * 10_000),
    stake: Math.round(before.stake * 1_000_000) !== Math.round(after.stake * 1_000_000),
  };
  return READING_FIELDS.filter((field) => changed[field]);
}
