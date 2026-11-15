import { normalizeStr } from "@/src/domain/text";

export type TotalDirection = "over" | "under";

/** Separa apenas uma linha numérica de uma unidade conhecida; U23 e nomes ficam intactos. */
export function separateCompactStatUnit(text: string): string {
  return text.replace(
    /(\d)(?=(?:cantos?|corners?|escanteios?|gols?|goals?|cards?|cart[oõ]es|bookings?|pontos?|points?|games?|sets?|shots?|remates?)\b)/gi,
    "$1 ",
  );
}

const LINE = String.raw`\d+(?:[.,]\d+)?`;
const OVER_WORD_LINE = String.raw`\+?\s*${LINE}`;
const UNDER_WORD_LINE = String.raw`[+\-]?\s*${LINE}`;
/** Palavras de direção de um total, como alternância de regex (texto normalizado). */
export const OVER_WORDS = "over|mais|acima|above";
export const UNDER_WORDS = "under|menos|abaixo|below";
const OVER_WORD = new RegExp(String.raw`\b(?:${OVER_WORDS})\b(?:\s+(?:de|que))?\s*${OVER_WORD_LINE}\b`);
const UNDER_WORD = new RegExp(String.raw`\b(?:${UNDER_WORDS})\b(?:\s+(?:de|que))?\s*${UNDER_WORD_LINE}\b`);
const OVER_WORD_ONLY = new RegExp(`^(?:${OVER_WORDS})$`);
const UNDER_WORD_ONLY = new RegExp(`^(?:${UNDER_WORDS})$`);
const TOTAL_UNIT =
  String.raw`(?:gols?|goals?|cantos?|corners?|escanteios?|cartoes?|carteos?|cards?|bookings?|` +
  String.raw`pontos?|points?|games?|jogos?|sets?|kills?|abates?|chutes?|shots?|` +
  String.raw`faltas?|fouls?|rebotes?|rebounds?|aces?|bases?|roubos?|steals?|` +
  String.raw`torres?|towers?|impedimentos?|offsides?)`;
const TOTAL_PERIOD =
  String.raw`\(?\s*(?:[12](?:o|º)?|primeiro|segundo)?\s*` +
  String.raw`(?:tempo|half|periodo|period|mapa|map|set)\b[^)]*\)?`;
const ABBREVIATED_SUFFIX = String.raw`(?:\s+(?:${TOTAL_UNIT}|${TOTAL_PERIOD}))?`;
const OVER_ABBREVIATED = abbreviatedTotalRegex("o|ov");
const UNDER_ABBREVIATED = abbreviatedTotalRegex("u|un");

/**
 * "O 2.5" / "U.1,5 cards" sozinhos, ou com o time na frente
 * ("Wolves O.1,5 cards"). Sem unidade/decimal, "Sporting U23" continua time.
 */
function abbreviatedTotalRegex(token: string): RegExp {
  const bare = String.raw`^\s*(?:${token})\s*\.?\s*${LINE}${ABBREVIATED_SUFFIX}\s*$`;
  const team = String.raw`[\p{L}\p{N}.'-]+(?:\s+[\p{L}\p{N}.'-]+)*`;
  const decimalLine = String.raw`\d+[.,]\d+`;
  const lineWithUnit = String.raw`${LINE}\s+(?:${TOTAL_UNIT}|${TOTAL_PERIOD})`;
  const prefixed = String.raw`^\s*${team}\s+(?:${token})\s*\.?\s*(?:${decimalLine}(?:\s+(?:${TOTAL_UNIT}|${TOTAL_PERIOD}))?|${lineWithUnit})\s*$`;
  return new RegExp(String.raw`(?:${bare})|(?:${prefixed})`, "u");
}
// A UNIDADE não decide direção — o `+` e a linha decidem. A whitelist antiga
// (gols/cartões/escanteios/pontos) recusava total de tênis (`+22.5 games`) e de
// eSports (`+25.5 kills`), que caíam em `ambiguous_selection` e iam para a fila
// manual. Continua exigindo uma palavra depois
// da linha para não confundir com nome de time (`Sporting U23`).
const POSITIVE_TOTAL_WITH_UNIT = new RegExp(
  String.raw`^\s*\+\s*${LINE}\s*[a-z][a-z ]*$`,
);
const BARE_POSITIVE_LINE = new RegExp(String.raw`^\s*\+\s*${LINE}\s*$`);
/**
 * Rótulo que nomeia AS DUAS direções ("Over/Under", "Mais/Menos"). É nome de
 * mercado, não escolha de lado — quem decide é a seleção.
 */
const COMPOSITE_BOTH_DIRECTIONS = new RegExp(
  String.raw`\b(?:${OVER_WORDS})\b\s*[/|-]\s*\b(?:${UNDER_WORDS})\b` +
    String.raw`|\b(?:${UNDER_WORDS})\b\s*[/|-]\s*\b(?:${OVER_WORDS})\b`,
  "g",
);

type TotalDirectionOptions = {
  /** Só use quando o mercado já foi classificado externamente como total. */
  allowBarePositiveLine?: boolean;
};

function directionText(selection: string): string {
  // O rótulo COMPOSTO ("Over/Under", "Mais/Menos") nomeia o mercado, não o
  // lado. Ele sai do texto ANTES de procurar direção: em "Over/Under 2.5" a
  // linha vinha logo depois de "under" e a função devolvia `under` com
  // confiança, liquidando todo mercado composto como Under. Remover em
  // vez de vetar preserva "Mais de 2.5 (Over/Under)", onde o composto é só um
  // parêntese ao lado de uma direção explícita.
  return normalizeStr(separateCompactStatUnit(selection)).replace(COMPOSITE_BOTH_DIRECTIONS, " ");
}

/**
 * "Flamengo O 1.5" → "Flamengo Over 1.5", "O89,5" → "Over 89,5": só a sigla
 * da direção vira palavra; time, unidade e período ficam. Quem procura o
 * sujeito do total pela palavra (o time do team total) lê assim a mesma forma
 * abreviada que `totalDirectionOf` aceita, com as mesmas travas ("Sporting
 * U23" continua nome).
 *
 * A guarda só aceita a sigla logo antes da linha do fim do texto, e é essa
 * que se troca: a primeira sigla seguida de dígito pode ser a categoria do
 * time ("Palmeiras U20 U 1.5", "U21 Spain U 2.5").
 */
export function expandAbbreviatedDirection(selection: string): string {
  const normalized = directionText(selection);
  const over = OVER_ABBREVIATED.test(normalized);
  if (over === UNDER_ABBREVIATED.test(normalized)) return selection;
  const [token, word] = over ? ["ov|o", "Over"] : ["un|u", "Under"];
  const last = [...selection.matchAll(new RegExp(String.raw`(^|\s)(?:${token})\s*\.?\s*(?=\d)`, "gi"))].at(-1);
  if (last?.index === undefined) return selection;
  const start = last.index + (last[1]?.length ?? 0);
  return `${selection.slice(0, start)}${word} ${selection.slice(last.index + last[0].length)}`;
}

/** Direção explícita de uma seleção de total, sem confundir nomes como Sporting U23. */
export function totalDirectionOf(
  selection: string,
  options: TotalDirectionOptions = {},
): TotalDirection | null {
  const normalized = directionText(selection);
  const over =
    OVER_WORD.test(normalized) ||
    OVER_WORD_ONLY.test(normalized) ||
    OVER_ABBREVIATED.test(normalized) ||
    POSITIVE_TOTAL_WITH_UNIT.test(normalized) ||
    (options.allowBarePositiveLine === true && BARE_POSITIVE_LINE.test(normalized));
  const under =
    UNDER_WORD.test(normalized) ||
    UNDER_WORD_ONLY.test(normalized) ||
    UNDER_ABBREVIATED.test(normalized);
  if (over === under) return null;
  return over ? "over" : "under";
}

export function looksLikeTotalSelection(selection: string): boolean {
  return totalDirectionOf(selection) !== null;
}
