import { z } from "zod";
import { classificarPropDeJogador, type PlayerPropFamily } from "./player-prop-classify";
import { tokensDaSelecao } from "./goalscorer-matching";
import { parseLineQuarters } from "./lines";
import { OVER_WORDS, totalDirectionOf, UNDER_WORDS } from "@/src/domain/mercados/total-direction";
import { canonicalSport } from "@/src/domain/sports/registry";

/** Source evidence, not an instruction or a bookmaker rule supplied by the LLM. */
export const playerPropInputSchema = z.object({
  jogador: z.string().trim().min(2).max(150),
  time: z.string().trim().max(200).optional(),
  mercadoOriginal: z.string().trim().min(2).max(300),
  selecaoOriginal: z.string().trim().min(2).max(300),
  substituicao: z.enum(["PRESENT", "ABSENT", "UNKNOWN"]).default("UNKNOWN"),
  evidencia: z.string().max(1000).default(""),
});
export type PlayerPropInput = z.input<typeof playerPropInputSchema>;
export type PlayerPropTerms = {
  version: 1;
  jogador: string;
  time: string | null;
  family: PlayerPropFamily;
  direction: "over" | "under" | null;
  lineQuarters: number | null;
  period: string;
  mercadoOriginal: string;
  selecaoOriginal: string;
  substituicao: "PRESENT" | "ABSENT" | "UNKNOWN";
  evidencia: string;
  unsupportedReason?: string;
};

/** Only postfix integer N+ means at least N. A prefix +N keeps its own meaning. */
export function normalizePlayerThreshold(selection: string): string {
  return selection.replace(/(?<![\d.,+\-])\b(\d+)\s*\+(?=$|\s|[)])/g, (_, raw: string) => {
    const n = Number(raw);
    return n > 0 && Number.isSafeInteger(n) ? `Over ${n - 0.5}` : `${raw}+`;
  });
}

// "ou" seguido de direção é só a linha ("2 ou mais") ou o rótulo do mercado
// ("Acima ou Abaixo", "Over or Under"); seguido de outra coisa, é combinação.
const UNSUPPORTED_QUALIFIER = new RegExp(
  String.raw`(?:%|percent|porcent|accuracy|precisao|aproveitamento|attempt|tentativ|\s&\s|\sand\s|\se\s|\s\+\s` +
    String.raw`|\s(?:ou|or)\s(?!(?:${OVER_WORDS}|${UNDER_WORDS}|more)\b))`,
  "i",
);

/** Mercado e seleção podem declarar a unidade ou uma condição que a contagem não prova. */
export function hasUnsupportedPlayerPropQualifier(...texts: string[]): boolean {
  return texts.some((text) => UNSUPPORTED_QUALIFIER.test(text));
}

/** Só N+ inteiro é limiar; o sufixo depois de decimal é evidência malformada. */
export function playerPropLineQuarters(selection: string): number | null {
  const normalized = normalizePlayerThreshold(selection);
  return /\d[.,]\d+\s*\+/.test(normalized) ? null : parseLineQuarters(normalized, { allowNegative: false });
}

export function buildPlayerPropTerms(input: {
  mercado: string; selecao: string; evento?: string; esporte?: string;
  playerProp?: PlayerPropInput | null;
}): PlayerPropTerms | null {
  const evidence = input.playerProp ? playerPropInputSchema.parse(input.playerProp) : null;
  const classification = classificarPropDeJogador({
    ...input,
    // Retain the player contract while sport identity is pending. Settlement
    // still requires a confirmed Soccer fixture; other sports stay unsupported.
    esporte: !canonicalSport(input.esporte) ? undefined : input.esporte,
    mercado: evidence && !/player|jogador/i.test(input.mercado) ? `Player ${input.mercado}` : input.mercado,
    // Evidence cannot replace the actual bet terms or change the statistic.
    selecao: normalizePlayerThreshold(input.selecao),
  });
  if (!classification) return null;
  const selection = normalizePlayerThreshold(input.selecao);
  // "Marcar ou dar assistência" também é combinação.
  const unsupportedReason = hasUnsupportedPlayerPropQualifier(input.mercado, input.selecao,
    evidence?.mercadoOriginal ?? "", evidence?.selecaoOriginal ?? "")
    ? "qualificador_ou_combinacao_sem_contrato" : undefined;
  return {
    version: 1,
    jogador: tokensDaSelecao(input.selecao).join(" "),
    time: evidence?.time || null,
    family: classification.family,
    direction: totalDirectionOf(selection, { allowBarePositiveLine: true }),
    // OCR como "Mais 0.5+" não significa "Over 4.5" (sufixo 5+).
    // Só N+ inteiro tem contrato; a extração deve reler a linha malformada.
    lineQuarters: playerPropLineQuarters(selection),
    period: classification.period ?? "FT",
    mercadoOriginal: evidence?.mercadoOriginal ?? input.mercado,
    selecaoOriginal: evidence?.selecaoOriginal ?? input.selecao,
    substituicao: evidence?.substituicao ?? "UNKNOWN",
    evidencia: evidence?.evidencia ?? "",
    ...(unsupportedReason ? { unsupportedReason } : {}),
  };
}
