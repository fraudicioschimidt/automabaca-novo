import { normalizeStr } from "@/src/domain/text";

/**
 * Nome de time posicionado DEPOIS da linha ("Over 1.5 Gols do Flamengo").
 *
 * A canonicalização da seleção e o SETTLEMENT precisam do mesmo recorte: se
 * só um reconhece o lado, o outro trata a aposta como total de JOGO e liquida
 * pelo placar agregado (0x3 daria WON para quem apostou no time que não
 * marcou). O vocabulário aqui é a fonte única das duas.
 */

/**
 * Unidades e preposições que separam a linha do nome do time. Vocabulário
 * RESTRITO de propósito: o que sobrar ainda precisa ser resolvido por
 * `matchTeamSide` contra o evento, então "corners 1st half" continua não
 * virando lado.
 */
export const TRAILING_UNIT_NOISE =
  /\b(?:de|do|da|dos|das|gols?|goals?|pontos?|points?|runs?|corridas?|cantos?|escanteios?|corners?|cartoes?|carteos?|cards?|bookings?|abates?|kills?|rebotes?|rebounds?|chutes?|shots?|finalizacoes?|assistencias?|assists?|faltas?|defesas?|saves?|torres?|towers?|bloqueios?|blocks?|aces?|tentativas?|attempts?|acertos?|hits?)\b/gi;

/** Limpa unidade/preposição/pontuação; null quando não sobra nada nomeável. */
export function trailingTeamCandidate(trailing: string): string | null {
  // Normaliza ANTES de limpar: a lista de unidades é sem acento e o texto do
  // tipster não ("Assistências", "Cartões").
  const candidate = normalizeStr(trailing)
    .replace(/[()[\]:;,–—-]/g, " ")
    .replace(TRAILING_UNIT_NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!candidate || !/[a-zà-ÿ]/i.test(candidate)) return null;
  return candidate;
}

/**
 * Trecho da seleção que vem DEPOIS da primeira linha numérica, já limpo.
 * Null quando a seleção não tem linha ou nada nomeável a segue.
 */
export function trailingTeamCandidateOfSelection(selecao: string): string | null {
  const normalized = normalizeStr(selecao);
  const line = normalized.match(/\d+(?:[.,]\d+)?/);
  if (!line || line.index === undefined) return null;
  return trailingTeamCandidate(normalized.slice(line.index + line[0].length));
}
