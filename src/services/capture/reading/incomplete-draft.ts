/**
 * Rascunho de canal: o universal já leu o jogo e só faltam números que o
 * tipster costuma preencher no edit, segundos ou minutos depois.
 *
 * Não é falha de provider. Chamar a cascata LLM ou TelegramParseRetryError
 * reprocessa o MESMO texto incompleto e, se a aposta já nasceu no edit,
 * queima cota em cima de um ticket existente.
 */

import { writesStake } from "@/src/domain/parse-bet-post";
import { hasBareSelectionOdd } from "./noise-filter";

const NUMBER_FIELDS = new Set(["stake", "odds"]);

const EMPTY_STAKE_LABEL =
  /^(?:stake|unidade?s?)\s*[:\-]\s*u?\s*$/im;
/** Odd entre parênteses ("Over 2.5 (1.90)"): escrita, só a regra não a lê. */
const PARENTHESIZED_ODD = /\(\s*\d{1,2}[.,]\d{1,3}\s*\)/;
const EMPTY_ODDS_LABEL =
  /^(?:odd?s?|cota[cç][aã]o|cota)\s*[:\-]?\s*$/im;

/**
 * Odd mínima escrita ("Odd mín: 1.70", "Min @1.70", "odd mínima 1,70"): o piso
 * que o tipster aceita, não a odd. Quando ela é o único preço, o post não é
 * rascunho, porque a odd não chega numa edição: a captura pergunta ao dono.
 */
const FLOOR_ODD = /\bm[ií]n(?:ima|imo|imum)?\.?\s*(?:odd\s*)?[:=@\-–]?\s*@?\s*\d+[.,]\d+/i;

export function mentionsFloorOdd(text: string): boolean {
  return FLOOR_ODD.test(text);
}

export function missingOnlyNumericFields(missing: readonly string[]): boolean {
  return missing.length > 0 && missing.every((field) => NUMBER_FIELDS.has(field));
}

export function hasEmptyStakeOrOddLabel(text: string): boolean {
  return EMPTY_STAKE_LABEL.test(text) || EMPTY_ODDS_LABEL.test(text);
}

/**
 * Falta só stake/odd → espera o edit. Mercado/seleção ausentes continuam na
 * cascata. Basta UM número que falta estar escrito num formato que o universal
 * não lê (odd sem "@" nem rótulo, odd entre parênteses, "Stake 3/10", "2%")
 * para o post ir à cascata: o erro barato é gastar uma chamada de IA, e a
 * stake escrita depois de uma odd que a regra não achou ("Ambas marcam 1.85"
 * + "💰 2") nem é vista pela regra. Se a IA também não achar o outro número,
 * a leitura dela é rascunho e a edição ainda o completa. Com a mínima como
 * único preço, a odd não chega numa edição: a cascata lê o resto e a captura
 * pergunta a odd.
 */
export function isIncompleteNumericDraft(
  text: string,
  missing: readonly string[],
): boolean {
  if (!missingOnlyNumericFields(missing)) return false;
  const writesMissingOdds = missing.includes("odds")
    && (hasBareSelectionOdd(text) || PARENTHESIZED_ODD.test(text) || mentionsFloorOdd(text));
  const writesMissingStake = missing.includes("stake") && writesStake(text);
  return !writesMissingOdds && !writesMissingStake;
}

/**
 * Rascunho com foto: a foto carrega o bilhete visual. A legenda só bloqueia a
 * Vision se contiver explicitamente um rótulo vazio (ex.: "Stake:", "ODD:").
 * Legendas informativas (links, odd de referência) seguem para a Vision.
 */
export function isPhotoCaptionIncompleteDraft(
  caption: string,
  missing: readonly string[],
): boolean {
  return hasEmptyStakeOrOddLabel(caption) && missingOnlyNumericFields(missing);
}
