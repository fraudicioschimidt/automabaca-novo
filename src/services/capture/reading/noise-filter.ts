import { normalizeStr, splitEventoTeams } from "@/src/domain/text";

/**
 * Filtro anti-ruído: decide se um post que a leitura por regra NÃO leu merece
 * a cascata de LLM. Exige pelo menos 2 sinais independentes de aposta. O post
 * barrado aqui não some: a captura o guarda para o painel.
 */

const BET_EMOJIS = /[⚽🏀🎾🏐🏒⚾🏈🎮💰📊🎯🔥💎]/u;

export function looksLikeChannelBetPost(text: string): boolean {
  if (!text || text.trim().length < 10) return false;
  // "Planilha atualizada" é rodapé comum de tip: barra só o que o leitor por
  // regra não leu.
  if (isResultRecap(text) || /\bplanilha atualizada\b/.test(normalizeStr(text))) return false;
  return betSignalCount(text) >= 2;
}

/**
 * Sinais independentes de aposta no texto: confronto, odd, stake, emoji,
 * rótulo de tip e seleção com odd. A DM usa o zero para responder sem IA.
 */
export function betSignalCount(text: string): number {
  let signals = 0;

  const lines = text.split("\n").map((l) => l.trim());
  if (lines.some(isFixtureLine)) signals += 1;

  // Odd plausível com contexto (@ ou rótulo, inclusive em PT).
  if (ODD_WITH_CONTEXT.test(text)) signals += 1;

  // Stake em unidades.
  if (/\d+(?:[.,]\d+)?\s*(?:u\b|un\b|unidades?\b)/i.test(text)) signals += 1;

  // Emoji típico de post de aposta.
  if (BET_EMOJIS.test(text)) signals += 1;

  // Rótulos estruturais de tip.
  if (/^(?:jogo|entrada|aposta|mercado|stake|odd)\s*[:\-]/im.test(text)) signals += 1;

  // Linha limpa comum de tipster: mercado + linha + odd, sem "@" nem rótulo.
  // É um sinal composto (não uma odd nua), para não promover placares/texto.
  if (
    /^(?:over|under|mais de|menos de|acima de|abaixo de)\s+[+-]?\d+(?:[.,]\d+)?\s*[-–—]\s*(?:1(?:[.,]\d{2,})|[2-9]\d*(?:[.,]\d+))\s*$/im.test(text)
  ) {
    signals += 1;
  }

  if (hasBareSelectionOdd(text)) signals += 1;

  return signals;
}

const BALANCE_PHRASES = /\b(resultado do dia|balanco|fechamento do dia|green do dia)\b/;
const RESULT_EMOJI = /[✅❌🟢🔴]/u;
// Times que começam por "Green"/"Red" não são resultado.
const RESULT_LINE = /^(?:resultado\s*[:\-]?\s*)?(?:green(?! bay)|red(?! (?:bull|star|wings|sox|devils))|void|bateu|perdeu|ganhou|anulad[ao]|reembolsad[ao]|devolvid[ao]|cashout|meio green|meio red)\b/;
/**
 * A palavra de resultado seguida da condição é regra do mercado ou da gestão,
 * não resultado: "Anulada se empatar", "Reembolsada se 2 gols", "Cashout aos 70'".
 */
const RESULT_CONDITION = /^(?:resultado\s*[:\-]?\s*)?\S+(?: green| red)?\s+(?:se|caso|quando|em caso|aos?|ate|antes|if)\b/;
/** Torcida pelo resultado que ainda não saiu ("Green 🙏"). */
const HOPE_EMOJI = /[🙏🤞🍀]/u;
const ODD_WITH_CONTEXT = /(?:@|\b(?:odd?s?|cota(?:[çc][ãa]o)?|pre[çc]o)\b\s*[:\-]?)\s*\d+(?:[.,]\d+)?/i;

/**
 * Balanço do dia ou recapitulação de resultado ("✅ GREEN", "RED", lista de
 * resultados): não é entrada nova, mesmo que o texto repita a tip inteira.
 * Uma linha conta quando começa pelo resultado (e é curta, para "Red Bull
 * Bragantino" não contar) ou traz o ❌ sozinho. Condição do mercado, pergunta
 * de gestão ("Perdeu? Não dobra.") e torcida não contam. O ✅, o 🟢 e o 🔴
 * sozinhos na linha são enfeite, divisor ou "ao vivo" numa tip com confronto e
 * odd: só contam no post sem cara de tip.
 */
export function isResultRecap(text: string): boolean {
  if (BALANCE_PHRASES.test(normalizeStr(text))) return true;
  const lines = text.split("\n").map((raw) => raw.trim());
  const looksLikeTip = ODD_WITH_CONTEXT.test(text) && lines.some(isFixtureLine);
  return lines.some((line) => {
    if (!line || isFixtureLine(line)) return false;
    const hasEmoji = RESULT_EMOJI.test(line);
    const words = normalizeStr(line.replace(/[✅❌🟢🔴]/gu, " ")).replace(/[^\p{L}\p{N}\s:\-]/gu, " ").replace(/\s+/g, " ").trim();
    if (hasEmoji && words === "") return line.includes("❌") || !looksLikeTip;
    const resultWords = words.replace(/\bcash[ -]+out\b/g, "cashout");
    if (/^cashout\s+(?:(?:total|parcial)\s+)?(?:disponivel|oferecido|oferta)\b/.test(resultWords)) return false;
    if (!RESULT_LINE.test(resultWords) || RESULT_CONDITION.test(resultWords.replace(/^cashout parcial\b/, "cashout")) || line.includes("?") || HOPE_EMOJI.test(line)) return false;
    return hasEmoji || resultWords.split(" ").length <= 4
      || /^cashout\s+(?:(?:total|parcial)\s+)?(?:realizado|efetuado|concluido)\b/.test(resultWords);
  });
}

/** Confronto "A vs B" com letras dos dois lados, que não seja assinatura de banca. */
function isFixtureLine(line: string): boolean {
  const teams = splitEventoTeams(line);
  return (
    teams !== null &&
    /\p{L}/u.test(teams.home) &&
    /\p{L}/u.test(teams.away) &&
    !isBankrollSignature(teams.home, teams.away)
  );
}

/**
 * Palavra logo antes do número que faz dele linha de mercado, horário ou data,
 * não odd: "Over 2.5", "Handicap 1.5", "às 21.30", "Sábado 23.09".
 */
const NOT_ODD_CONTEXT =
  /\b(?:over|under|o|u|mais de|menos de|acima de|abaixo de|handicap|linha|ah|eh|as|hora|horas|horario|inicio|kickoff|ko|hoje|amanha|data|dia|domingo|segunda|terca|quarta|quinta|sexta|sabado|stake|unidades?|units?|valor)\s*[:\-]?$/;
/** Número com cara de horário ("21.30") depois do nome da competição é o horário do jogo. */
const COMPETITION_WORDS =
  /\b(?:liga|league|campeonato|brasileirao|serie|copa|cup|premier|laliga|bundesliga|ligue|eredivisie|libertadores|sudamericana|champions|europa|nba|nfl|nhl|mlb|atp|wta|itf|torneio)\b/;
const TIME_LIKE = /^(?:[01]?\d|2[0-3])[.,][0-5]\d$/;
const RESULT_WORDS = /\b(?:green|red|void|bateu|perdeu|anulad[ao])\b/;
const MIN_BARE_ODD = 1.01;
const MAX_BARE_ODD = 30;

/**
 * Odd decimal sem "@" nem rótulo no fim da linha da seleção ("Ambas marcam
 * 1.85"). Não vale na linha do confronto nem depois de competição ou com
 * cara de horário acima de 10 (é horário), com rótulo de stake, com sinal
 * colado ("-1.5" é linha de handicap), no formato de linha ("9.5") nem com
 * marcador de resultado na própria linha ("Ambas marcam 1.85 ✅"), que é
 * recapitulação. Um "🔴 AO VIVO" ou "✅ Planilha" em outra linha não apaga a
 * odd: a recapitulação do post inteiro é barrada antes, por `isResultRecap`.
 */
export function hasBareSelectionOdd(text: string): boolean {
  return text.split("\n").some((raw) => {
    const line = raw.trim();
    if (isFixtureLine(line) || /[✅❌🟢🔴]/u.test(line) || RESULT_WORDS.test(normalizeStr(line))) return false;
    const match = /^(.*\p{L}.*?)\s+(\d{1,2}[.,]\d{1,2})$/u.exec(line);
    if (!match?.[1] || !match[2]) return false;
    const before = normalizeStr(match[1]);
    if (NOT_ODD_CONTEXT.test(before) || /[.,]5$/.test(match[2])) return false;
    const odd = Number(match[2].replace(",", "."));
    if (TIME_LIKE.test(match[2]) && (odd >= 10 || COMPETITION_WORDS.test(before))) return false;
    return odd >= MIN_BARE_ODD && odd <= MAX_BARE_ODD;
  });
}

/**
 * "Luis / SL" e "Staking Nicolas / SL" são assinatura de banca, não confronto.
 * Sem este recorte o `@1.6` de um comentário ("se voltar -1 pode pegar")
 * somava 2 sinais e a cascata LLM retentava o post por horas.
 */
function isBankrollSignature(home: string, away: string): boolean {
  const sides = [normalizeStr(home), normalizeStr(away)];
  if (sides.some((side) => side === "sl" || side === "stop loss" || side === "stoploss")) {
    return true;
  }
  return sides.some((side) => /\bstaking\b/.test(side));
}
