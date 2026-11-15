import {
  captionDeclaresPromotionFunding,
  captionDeclaresTradingOperation,
  hasUnsupportedPromotionTerms,
  hasUnsupportedTradingTerms,
  MAX_AUTO_CAPTURE_ODDS,
  MAX_AUTO_CAPTURE_STAKE_UNITS,
  type ParsedBetPost,
} from "@/src/domain/bet-capture";
import {
  asianHandicapLineNeedsRetry,
  asianHandicapSideNeedsRetry,
} from "@/src/domain/asian-handicap-line";
import { resolveCaptureStake } from "@/src/domain/capture-stake-policy";
import { captionStakeUnits } from "@/src/domain/player-prop-capture";
import {
  resolveCapturePolicy,
  type CapturePolicyDecision,
} from "@/src/domain/capture-policy";
import {
  HALF_PERIOD_ABBREVIATIONS,
  HALF_PERIOD_PHRASES,
  isCombinedBttsMarket,
  isMethodOfVictoryMarket,
  isOutrightMarket,
  isRaceToMarket,
  isThreeWayHandicapMarket,
  marketKindOf,
} from "@/src/domain/mercados/classify";
import { normalizeMercadoKey, resolveMercadoStatic } from "@/src/domain/mercados/catalog";
import { isCombinedSelection } from "@/src/domain/mercados/selecao";
import { selecaoPareceHandicap, selecaoPareceTotal, stripSelectionOdds } from "@/src/domain/mercados/selection-shape";
import { oddsDivergeWidely } from "@/src/domain/odds-compare";
import type { CapturePolicy } from "@/src/generated/prisma/enums";
import { mentionsLiveEntryNearBet, resolveLiveScoreAtTip, stripKickoffFromSelection } from "@/src/domain/live-score-at-tip";
import { parseLineQuarters } from "@/src/domain/settlement/lines";
import { lineSubjectIsNotEventTeam } from "@/src/domain/settlement/over-under-subject";
import { matchMoneylineSelection, stripTeamNames } from "@/src/domain/settlement/sides";
import { UNKNOWN_SPORT } from "@/src/domain/sports/detect";
import { esportesComUnidade } from "@/src/domain/sports/registry";
import { normalizeStr } from "@/src/domain/text";
import { extractCaptionBetHints } from "@/src/services/capture/preparation/parse-caption-hints";
import { enrichParsedBetFromCaption } from "@/src/services/capture/preparation/parse-caption-enrich";

/**
 * Porteiro pré-`registerBet`: enrich da legenda + política da banca + rejeição de
 * odd/stake inválidos ou suspeitos (min informativo, diverge do `@`).
 * Puro — retries de vision ficam no orquestrador de captura.
 */

export type CaptureGuardReject = {
  ok: false;
  missing: string[];
  reason: string;
};

export type CaptureGuardOk = {
  ok: true;
  bet: ParsedBetPost;
};

export type CaptureGuardResult = CaptureGuardOk | CaptureGuardReject;

/**
 * De onde vieram os números: do print (imagem) ou do próprio texto do post; se
 * a odd foi respondida pelo dono no conserto pela DM, que é conferência humana;
 * e os esportes que o dono marcou no canal (vazio = "vários/não sei").
 */
export type CaptureReadingSource = {
  readFromImage?: boolean; oddsFromOwner?: boolean; channelSports?: readonly string[];
  /** A legenda é a do post com várias apostas: o placar, a stake e a odd escritos nela podem ser de outro item. */
  sharedCaption?: boolean;
};

/**
 * Odd e stake da legenda. A stake fixa da banca não lê a da legenda, e a do
 * item de lote é lida à parte (`batchItemStake`).
 */
function captionHints(bet: ParsedBetPost, caption: string, source: CaptureReadingSource) {
  return extractCaptionBetHints(caption, { ignoreStake: source.sharedCaption || bet.stakePolicySnapshot?.source === "bankroll_fixed" });
}

/**
 * Odd e stake explícitas na legenda contra a leitura.
 *
 * Stake escrita na legenda vale, exceto quando a banca escolheu stake fixa.
 * Odd: no print vale a do PRINT (decisão do dono); a da legenda só entra
 * quando a banca manda nela (CAPTION_ODD) ou quando a aposta foi lida do
 * próprio texto, que é a legenda. Divergência grande entre as duas é recusa:
 * uma delas foi lida errada e o guard não escolhe. No item de lote, a odd
 * única da legenda é de uma das apostas do post: só a divergência conta.
 */
function applyCaptionNumbers(
  bet: ParsedBetPost,
  caption: string,
  decision: CapturePolicyDecision,
  policy: CapturePolicy,
  source: CaptureReadingSource,
): CaptureGuardResult {
  const hints = captionHints(bet, caption, source);
  if (hints.ambiguous) {
    return { ok: false, missing: ["aposta"], reason: "legenda_com_multiplas_apostas" };
  }
  if (hints.odds !== undefined && Number.isFinite(bet.odds) && bet.odds > 1 && oddsDivergeWidely(bet.odds, hints.odds)) {
    return { ok: false, missing: ["odds"], reason: "odd_diverge_legenda" };
  }
  // Intervalo ("1-2u"): o guard não escolhe a ponta, e o dono informa a stake.
  if (hints.stakeUnreadable) return { ok: false, missing: ["stake"], reason: "stake_invalido" };
  const captionOddWins = !source.sharedCaption && (source.readFromImage ? policy === "CAPTION_ODD" : decision.captionOddAuthoritative);
  const withOdds = { ...bet, odds: hints.odds !== undefined && captionOddWins ? hints.odds : bet.odds };
  if (source.sharedCaption) return batchItemStake(withOdds, caption);
  return { ok: true, bet: { ...withOdds, ...(hints.stake !== undefined ? captionStake(withOdds, hints.stake) : {}) } };
}

/**
 * Item de lote com a legenda do post inteiro: uma stake só nela vale para
 * todas as apostas se ela diz "cada" (a regra da leitura); sem isso, a que
 * diverge da stake do item é recusa, porque o guard não sabe de qual aposta
 * ela é. A soma do lote ("Total: 3u") não é stake, e duas stakes diferentes
 * são a legenda com várias apostas. A stake fixa da banca não lê a legenda.
 */
function batchItemStake(bet: ParsedBetPost, caption: string): CaptureGuardResult {
  if (bet.stakePolicySnapshot?.source === "bankroll_fixed") return { ok: true, bet };
  const units = captionStakeUnits(caption);
  const stakes = [...new Set(units.stakes)];
  if (stakes.length > 1) return { ok: false, missing: ["aposta"], reason: "legenda_com_multiplas_apostas" };
  const [stake] = stakes;
  if (stake === undefined || stake === bet.stake) return { ok: true, bet };
  if (!units.each) return { ok: false, missing: ["stake"], reason: "stake_diverge_legenda" };
  return { ok: true, bet: { ...bet, ...captionStake(bet, stake) } };
}

/**
 * A stake da legenda passa pela política da banca, e o snapshot vai junto: o
 * registro refaz a stake pelo snapshot e recusa quando as duas divergem. A
 * legenda que repete a stake atual não muda a origem: o lote de props passa
 * aqui a stake padrão da banca escrita como legenda ("1u"), e ela continua da banca.
 */
function captionStake(bet: ParsedBetPost, stake: number): Pick<ParsedBetPost, "stake" | "stakePolicySnapshot"> {
  if (!bet.stakePolicySnapshot) return { stake };
  if (stake === bet.stake) return { stake: bet.stake, stakePolicySnapshot: bet.stakePolicySnapshot };
  const resolved = resolveCaptureStake(stake, bet.stakePolicySnapshot);
  return { stake: resolved.stake ?? bet.stake, stakePolicySnapshot: resolved.snapshot ?? bet.stakePolicySnapshot };
}

/** Resultado combinado com gols, ambas ou total ("Resultado Final e Total de Gols", "Resultado + Ambas"). */
const COMBINED_RESULT_MARKET =
  /\b(?:resultado|vencedor|1x2|moneyline|ml)\b.*(?:\be\b|\+|&|\/).*\b(?:total|gols?|ambas|btts|over|under|mais|menos)\b/;

/** Resultado no intervalo e no fim ("Intervalo/Final", "HT/FT"), já sem a pontuação. */
const HALF_TIME_FULL_TIME_MARKET = /\b(?:intervalo|half ?time|ht)\s+(?:e\s+)?(?:final|full ?time|ft)\b/;

/** Mercados que o classificador reconhece como fora do placar simples, mesmo com seleção de time e linha. */
function isRecognizedExoticMarket(mercado: string, selecao: string): boolean {
  return isMethodOfVictoryMarket(mercado) || isRaceToMarket(mercado, selecao) || isThreeWayHandicapMarket(mercado);
}

/**
 * Período escrito na seleção ("1T", "1ºT", "PT", "HT", "FT", "2º Tempo", "1º
 * Quarto", "Q1", "1Q"), já normalizado: o ordinal vira espaço ("1ºT" é "1 t").
 * "PT"/"ST" só contam logo antes da direção, para "St Pauli Over 1.5" manter o time.
 */
const SELECTION_PERIOD = new RegExp(String.raw`\b(?:${[
  ...HALF_PERIOD_PHRASES.first, ...HALF_PERIOD_PHRASES.second,
  ...HALF_PERIOD_ABBREVIATIONS.first, ...HALF_PERIOD_ABBREVIATIONS.second,
  String.raw`[12]\s+t`, String.raw`(?:pt|st)(?=\s+(?:over|under|mais|menos)\b)`,
  "ft", "full time", String.raw`[1-4]\s*(?:o\s+)?(?:quartos?|quarters?|periodos?|periods?)`,
  String.raw`(?:quartos?|quarters?)\s*[1-4]`, String.raw`q\s*[1-4]`, String.raw`[1-4]\s*q`, String.raw`[1-4](?:st|nd|rd|th)\s+quarter`,
].join("|")})\b`, "g");

/**
 * A seleção tem a forma de um mercado de placar simples: total do jogo ou de
 * um time do confronto, handicap, vencedor ou Sim/Não. Total com jogador na
 * frente ("LeBron James Over 25.5") é prop, não placar; o período ("1T Over
 * 110.5") e a unidade ("Total de gols Over 2.5") antes da linha não são jogador.
 */
function hasSimpleScoreSelection(bet: ParsedBetPost): boolean {
  const selecao = stripSelectionOdds(bet.selecao);
  if (selecaoPareceTotal(selecao)) {
    const withoutPeriod = normalizeStr(selecao).replace(/[^a-z0-9]+/g, " ").replace(SELECTION_PERIOD, " ");
    return !lineSubjectIsNotEventTeam(withoutPeriod, bet.evento);
  }
  return selecaoPareceHandicap(selecao)
    || matchMoneylineSelection(selecao, bet.evento, { strict: true }) !== null
    || /^(?:sim|nao|yes|no)$/.test(normalizeMercadoKey(selecao));
}

/**
 * Mercados em que odd acima do teto é normal: placar exato e total exato,
 * artilheiro, jogador, outright, combinados (intervalo/final, resultado e
 * ambas, resultado e total) e o que não é placar simples. Nos demais — até
 * Money Line de azarão, que é raro — "@185" é quase sempre 1,85 sem o ponto.
 * Parte do jogo (quarto, set, período, janela de minutos) não muda isso: o
 * total, o vencedor e o handicap dela têm o teto do jogo inteiro.
 * O nome é classificado já traduzido pelo catálogo ("Gols" é Total), e um nome
 * que o classificador não conhece só libera a odd quando a seleção não tem
 * forma de placar simples: senão "Mercado: Gols" + "Over 2.5 @185" passaria.
 */
function allowsHighOdds(bet: ParsedBetPost): boolean {
  if (bet.legs || isOutrightMarket(bet.mercado) || isCombinedBttsMarket(bet.mercado)) return true;
  const key = normalizeMercadoKey(bet.mercado);
  if (/\b(?:exato|exata|exact)\b/.test(key) || COMBINED_RESULT_MARKET.test(key) || HALF_TIME_FULL_TIME_MARKET.test(key)) return true;
  const mercado = resolveMercadoStatic(bet.mercado) ?? bet.mercado;
  const kind = marketKindOf(mercado, bet.selecao, bet.evento);
  if (kind === "correct_score" || kind === "scorer") return true;
  if (kind !== "player_props" && kind !== "other") return false;
  return isRecognizedExoticMarket(mercado, bet.selecao) || !hasSimpleScoreSelection(bet);
}

/** Esportes de placar em gols, que têm empate no tempo normal e por isso handicap europeu. */
const SPORTS_WITH_DRAW = new Set(esportesComUnidade("gols"));

/** O tipo escrito no post, na legenda ou no rótulo lido do print: "asiático"/"AH" ou "europeu"/"3 vias". */
const HANDICAP_TYPE_WRITTEN = /\b(?:asiatic[oa]s?|asian|ah|europeu|europeia|european|europeo|3\s*vias?|3\s*way|three\s*way)\b/;

/**
 * Handicap de linha inteira sem o tipo escrito, num esporte com empate: no
 * asiático a cobertura exata devolve, no europeu (a aba "Handicap" da Bet365)
 * perde. Vale para "Handicap" e também para "Handicap – Match", o nome do
 * asiático que o leitor pode escrever sem o post dizer o tipo. Linha 0, de meio
 * ou de quarto só existe no asiático; basquete e tênis não têm europeu. Esporte ainda
 * não lido conta como possível empate, salvo quando o dono marcou o canal só
 * com esportes sem ele.
 */
function handicapTypeIsAmbiguous(bet: ParsedBetPost, caption: string, channelSports: readonly string[] = []): boolean {
  const key = normalizeMercadoKey(bet.mercado);
  if (key !== "handicap" && key !== "handicap match") return false;
  const sport = normalizeStr(bet.esporte);
  const sportUnread = !sport || sport === normalizeStr(UNKNOWN_SPORT);
  const mayDraw = SPORTS_WITH_DRAW.has(sport)
    || (sportUnread && (!channelSports.length || channelSports.some((name) => SPORTS_WITH_DRAW.has(normalizeStr(name)))));
  if (!mayDraw || HANDICAP_TYPE_WRITTEN.test(normalizeStr(`${caption} ${bet.mercado} ${bet.selecao}`))) return false;
  const quarters = parseLineQuarters(stripTeamNames(bet.selecao, bet.evento), { allowNegative: true });
  // Linha 0 só existe no asiático (no europeu seria o próprio resultado final).
  return quarters !== null && quarters !== 0 && quarters % 4 === 0;
}

/** Handicap ao vivo liquida pelo placar RESTANTE: sem o placar da entrada, pagaria o jogo inteiro. */
function liveHandicapWithoutScore(bet: ParsedBetPost, caption: string): boolean {
  const handicap = marketKindOf(bet.mercado, bet.selecao, bet.evento) === "spread" || selecaoPareceHandicap(bet.selecao);
  return handicap && (mentionsLiveEntryNearBet(caption, bet.selecao) || mentionsLiveEntryNearBet(bet.liveScoreEvidence, null));
}

/** Os termos da aposta inteiros; da legenda livre, só a linha que rotula esta aposta. */
function unsupportedFinancialTerms(bet: ParsedBetPost, caption: string): CaptureGuardResult | null {
  const terms = [bet.mercado, bet.selecao, ...(bet.legs?.legs.flatMap((leg) => [leg.mercado, leg.selecao]) ?? [])];
  if (hasUnsupportedTradingTerms(...terms) || captionDeclaresTradingOperation(caption)) {
    return { ok: false, missing: ["aposta"], reason: "unsupported_trading_terms" };
  }
  if (hasUnsupportedPromotionTerms(...terms) || captionDeclaresPromotionFunding(caption)) {
    return { ok: false, missing: ["aposta"], reason: "unsupported_promotion_terms" };
  }
  return null;
}

export function validateParsedBetBeforeRegister(
  bet: ParsedBetPost,
  caption: string,
  policy: CapturePolicy,
  source: CaptureReadingSource = {},
): CaptureGuardResult {
  const unsupported = unsupportedFinancialTerms(bet, caption);
  if (unsupported) return unsupported;
  const hints = captionHints(bet, caption, source);
  const decision = resolveCapturePolicy(policy, caption);

  if (hints.ambiguous) {
    return { ok: false, missing: ["aposta"], reason: "legenda_com_multiplas_apostas" };
  }

  if (!bet.evento?.trim()) {
    return { ok: false, missing: ["evento"], reason: "evento_ausente" };
  }
  if (!bet.selecao?.trim()) {
    return { ok: false, missing: ["selecao"], reason: "selecao_ausente" };
  }
  // Combinada lida sem as pernas num mercado simples ("Both Teams to Score" +
  // "Sim e Over 2.5"): gravada assim, a liquidação responderia só uma condição.
  // O rótulo que já declara a combinação ("Resultado + Ambas marcam") segue.
  const marketIsCombined = marketKindOf(bet.mercado) === "other" || isCombinedBttsMarket(bet.mercado)
    || COMBINED_RESULT_MARKET.test(normalizeMercadoKey(bet.mercado));
  if (!bet.legs && !marketIsCombined && isCombinedSelection(bet.selecao, bet.evento)) {
    return { ok: false, missing: ["selecao"], reason: "selecao_combinada" };
  }
  if (
    marketKindOf(bet.mercado) === "spread" &&
    asianHandicapLineNeedsRetry(bet.selecao, bet.evento)
  ) {
    return { ok: false, missing: ["selecao"], reason: "linha_handicap_ausente" };
  }
  if (
    marketKindOf(bet.mercado) === "spread" &&
    asianHandicapSideNeedsRetry(bet.selecao, bet.evento, bet.mercado)
  ) {
    return { ok: false, missing: ["selecao"], reason: "lado_handicap_ausente" };
  }
  if (handicapTypeIsAmbiguous(bet, caption, source.channelSports)) {
    return { ok: false, missing: ["mercado"], reason: "handicap_tipo_ambiguo" };
  }
  if (!Number.isFinite(bet.odds) || bet.odds <= 1) {
    return { ok: false, missing: ["odds"], reason: "odd_invalida" };
  }
  if (!Number.isFinite(bet.stake) || bet.stake <= 0) {
    return { ok: false, missing: ["stake"], reason: "stake_invalido" };
  }
  // Dentro do teto de sanidade mas implausível como UNIDADES lidas do post
  // ("Valor: 50", "R$ 4.000"): recusa para revisão em vez de mover o ledger.
  // A stake que a banca define não passa por aqui: é configuração do dono.
  const stakeFromPost = (bet.stakePolicySnapshot?.source ?? "message") === "message";
  if (stakeFromPost && bet.stake > MAX_AUTO_CAPTURE_STAKE_UNITS) {
    return { ok: false, missing: ["stake"], reason: "stake_implausivel" };
  }
  if (bet.odds > MAX_AUTO_CAPTURE_ODDS && !source.oddsFromOwner && !allowsHighOdds(bet)) {
    return { ok: false, missing: ["odds"], reason: "odd_implausivel" };
  }

  // Canal cuja odd mora na legenda: `@` presente e ilegível é rejeição, não palpite.
  if (decision.requireCaptionOdd && hints.odds === undefined) {
    return { ok: false, missing: ["odds"], reason: "odd_legenda_ausente" };
  }

  return { ok: true, bet };
}

/** Enrich → odd e stake da legenda → validação. Entry-point síncrono do guard. */
export function finalizeParsedBetForCapture(
  read: ParsedBetPost,
  caption: string,
  policy: CapturePolicy,
  source: CaptureReadingSource = {},
): CaptureGuardResult {
  const unsupported = unsupportedFinancialTerms(read, caption);
  if (unsupported) return unsupported;
  // O horário do jogo colado à seleção ("Lakers -4.5 (21:00)") esconderia a linha.
  const bet = { ...read, selecao: stripKickoffFromSelection(read.selecao) };
  const liveScore = resolveLiveScoreAtTip({
    liveScoreHome: bet.liveScoreHome,
    liveScoreAway: bet.liveScoreAway,
    texts: [bet.selecao, bet.liveScoreEvidence, source.sharedCaption ? null : caption],
    market: bet.mercado,
  });
  if (!liveScore.ok) {
    return {
      ok: false,
      missing: ["placarLive"],
      reason: liveScore.reason,
    };
  }
  // O par que sai daqui é gravado e lido como verdade depois que a legenda
  // expira: 0-0 que o resolvedor tratou como ruído não segue adiante.
  const enriched = enrichParsedBetFromCaption(
    {
      ...bet,
      liveScoreHome: liveScore.score?.home,
      liveScoreAway: liveScore.score?.away,
    },
    caption,
  );
  if (!liveScore.score && liveHandicapWithoutScore(enriched, caption)) {
    return { ok: false, missing: ["placarLive"], reason: "placar_ao_vivo_ausente" };
  }
  const decision = resolveCapturePolicy(policy, caption);
  const withCaption = applyCaptionNumbers(enriched, caption, decision, policy, source);
  if (!withCaption.ok) return withCaption;
  return validateParsedBetBeforeRegister(withCaption.bet, caption, policy, source);
}
