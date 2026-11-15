import type { ParsedBetPost } from "@/src/domain/bet-capture";
import type { LiveScoreAtTip } from "@/src/domain/live-score-at-tip";
import { canonicalSport, type CanonicalSport } from "@/src/domain/sports/registry";
import { marketKindOf } from "@/src/domain/mercados/classify";
import { selecaoPareceHandicap, selectionTotalLine } from "@/src/domain/mercados/selection-shape";
import { hasNonScoreStatQualifier, hasScoreUnitMismatch } from "@/src/domain/mercados/stat-qualifier";
import { parseLineQuarters } from "@/src/domain/settlement/lines";
import { buildPlayerPropTerms } from "@/src/domain/settlement/player-prop-terms";
import { stripTeamNames } from "@/src/domain/settlement/sides";
import { detectSportFromText, llmReadSport, SHARED_SOCCER_LEAGUE, SPORT_AUTO_CONFIRM_MIN_CONFIDENCE, SPORT_DISSENT_MIN_CONFIDENCE, SPORT_RESOLVER_VERSION, UNKNOWN_SPORT, unresolvedSportDecision, type SportEvidence, type SportResolutionDecision } from "@/src/domain/sports/detect";
import { normalizeStr, splitEventoTeams } from "@/src/domain/text";
import {
  channelPicksHomonym,
  CONTRADICTED_STRATEGY_SUFFIX,
  LOCAL_IDENTITY_CANDIDATE_CONFIDENCE,
  votingPostSignals,
} from "@/src/services/bets/sport-resolution/decision";
import type { SportCandidate, SportSignal } from "@/src/services/bets/sport-resolution/types";

/**
 * Decisão canônica antes da persistência. O esporte só textual nunca basta
 * para confirmar uma captura Telegram: é preciso evidência produzida pelo
 * parser atual ou um sinal determinístico presente no conteúdo.
 */
export function resolveSportForCapture(params: {
  bet: ParsedBetPost;
  caption: string;
}): SportResolutionDecision {
  const parsed = params.bet.sportResolution;
  const extraEvidence = (parsed?.evidence ?? [])
    .filter((e) => e.source === "TEXT" || e.source === "COMPETITION" || (e.source === "LLM" && e.value && e.value !== "classificação estruturada"))
    .map((e) => e.value);
  // A legenda é a do post inteiro, também no lote: a leitura do item decide
  // se a liga compartilhada dele cede à outra modalidade do post.
  const deterministic = detectSportFromText(
    [params.caption, params.bet.competicao, params.bet.mercado, params.bet.selecao, ...extraEvidence]
      .filter(Boolean)
      .join("\n"),
    { itemSport: llmReadSport(parsed) },
  );

  if (
    deterministic.status === "CONFIRMED" &&
    deterministic.confidence >= SPORT_AUTO_CONFIRM_MIN_CONFIDENCE
  ) {
    if (
      parsed?.status === "CONFIRMED" &&
      parsed.sport &&
      parsed.sport !== deterministic.sport
    ) {
      return unresolvedSportDecision("CONFLICT", [
        ...parsed.evidence,
        ...deterministic.evidence,
      ]);
    }
    // A liga que a linha desmente cede como a que a IA leu em outro esporte
    // (`detectSportFromText`): some da evidência, e a leitura da IA fica.
    if (sharedSoccerLeagueRefuted(deterministic, { ...params.bet, scores: postScores(params.bet, params.caption) })) {
      return unresolvedSportDecision("PENDING", (parsed?.evidence ?? []).filter((item) => item.source === "LLM"));
    }
    return deterministic;
  }
  if (deterministic.status === "CONFLICT") {
    return unresolvedSportDecision("CONFLICT", [
      ...(parsed?.evidence ?? []),
      ...deterministic.evidence,
    ]);
  }
  if (parsed) return parsed;

  // O rascunho de DM traz só o esporte textual: sem proveniência ele serve
  // apenas como candidato fraco e nunca como confirmação automática.
  const textualCandidate = canonicalSport(params.bet.esporte);
  if (!textualCandidate || params.bet.esporte === UNKNOWN_SPORT) {
    return unresolvedSportDecision();
  }
  return {
    sport: textualCandidate,
    status: "PENDING",
    confidence: 40,
    source: "UNRESOLVED",
    evidence: [],
    resolverVersion: SPORT_RESOLVER_VERSION,
  };
}

/** O dono disse que o canal só posta aquele esporte: acima do limiar de confirmação. */
export const CHANNEL_SPORT_CONFIDENCE = 95;

/** Só nomes do registro valem; um valor desconhecido gravado é ignorado. */
export function canonicalChannelSports(stored: readonly string[] | undefined): CanonicalSport[] {
  return [...new Set((stored ?? []).map(canonicalSport).filter((sport): sport is CanonicalSport => sport !== null))];
}

function channelEvidence(channelSports: readonly CanonicalSport[]): SportEvidence[] {
  return channelSports.map((sport) => ({
    source: "CHANNEL",
    sport,
    confidence: channelSports.length === 1 ? CHANNEL_SPORT_CONFIDENCE : 50,
    value: "esportes do canal",
  }));
}

/** Fontes que leem o post: esporte delas fora do canal contradiz a marcação do dono. */
const POST_SIGNAL_SOURCES = new Set(["TEXT", "EMOJI", "COMPETITION", "LLM"]);

type PostEvidence = { source: string; sport: CanonicalSport; confidence?: number };

/**
 * O que a leitura do post apontou, com a confiança, mesmo abaixo do limiar.
 * A IA que o texto do post desmente não conta (`votingPostSignals`).
 */
export function postSignals(evidence: readonly PostEvidence[]): SportSignal[] {
  return votingPostSignals(evidence
    .filter((item) => POST_SIGNAL_SOURCES.has(item.source))
    .map((item) => ({ sport: item.sport, source: item.source, confidence: item.confidence ?? 0 })));
}

/** Esportes que a leitura do post apontou, mesmo abaixo do limiar. */
export function postSignalSports(evidence: readonly PostEvidence[]): CanonicalSport[] {
  return [...new Set(postSignals(evidence).map((signal) => signal.sport))];
}

/**
 * Esportes da leitura do post que desmentem a identidade local: o texto, o
 * emoji e a competição do post, e a IA a partir de
 * `SPORT_DISSENT_MIN_CONFIDENCE`. O palpite fraco da IA não derruba a
 * identidade dos times.
 */
export function refutingPostSports(signals: readonly SportSignal[]): CanonicalSport[] {
  return [...new Set(signals
    .filter((signal) => signal.source !== "LLM" || signal.confidence >= SPORT_DISSENT_MIN_CONFIDENCE)
    .map((signal) => signal.sport))];
}

type TotalLineTerms = Pick<ParsedBetPost, "mercado" | "selecao" | "evento" | "playerProp">;

/**
 * Total fora da escala do esporte: basquete abaixo de 50 é outra unidade
 * (quarto, time, jogador) ou outro esporte; futebol não chega a 50. O "1" de
 * "1T Over 110.5" é o período, não a linha.
 */
export function totalLineImplausible(sport: CanonicalSport, bet: TotalLineTerms): boolean {
  if (buildPlayerPropTerms(bet) || marketKindOf(bet.mercado, bet.selecao, bet.evento) !== "total") return false;
  const line = selectionTotalLine(bet.selecao, bet.evento);
  if (line === null) return false;
  return (sport === "Basketball" && line < 50) || (sport === "Soccer" && line >= 50);
}

/**
 * Handicap de jogo inteiro acima do qual a linha discorda do esporte: no
 * futebol, mais de 5 gols (existe contra San Marino, mas é raro); no
 * basquete, mais de 60 pontos (acima disso é total lido como handicap).
 */
const MAX_PLAUSIBLE_HANDICAP: Partial<Record<CanonicalSport, number>> = { Soccer: 5, Basketball: 60 };

/**
 * Handicap fora da escala do esporte ("Flamengo +8.5" não é futebol).
 * Escanteio, cartão e jogador têm outra escala e ficam de fora.
 */
function handicapLineImplausible(sport: CanonicalSport, bet: TotalLineTerms): boolean {
  const max = MAX_PLAUSIBLE_HANDICAP[sport];
  if (max === undefined || buildPlayerPropTerms(bet) || hasNonScoreStatQualifier(bet.mercado, bet.selecao)) return false;
  if (marketKindOf(bet.mercado, bet.selecao, bet.evento) !== "spread" && !selecaoPareceHandicap(bet.selecao)) return false;
  const quarters = parseLineQuarters(stripTeamNames(bet.selecao, bet.evento), { allowNegative: true });
  return quarters !== null && Math.abs(quarters) / 4 > max;
}

/** Gols que um jogo de futebol não chega a somar: placar acima disso é de outro esporte. */
const SOCCER_MAX_PLAUSIBLE_GOALS = 20;

function endsWithWord(text: string, word: string): boolean {
  return text.endsWith(word) && !/[\p{L}\p{N}]$/u.test(text.slice(0, text.length - word.length));
}

function startsWithWord(text: string, word: string): boolean {
  return text.startsWith(word) && !/^[\p{L}\p{N}]/u.test(text.slice(word.length));
}

/** Placar escrito entre os nomes dos times, em qualquer ordem: "Botafogo 77x97 Flamengo". */
function scoreBetweenTeams(evento: string, caption: string): LiveScoreAtTip | null {
  const teams = splitEventoTeams(evento);
  if (!teams) return null;
  const home = normalizeStr(teams.home).replace(/\s+/g, " ");
  const away = normalizeStr(teams.away).replace(/\s+/g, " ");
  for (const line of caption.split(/\r?\n/)) {
    const text = normalizeStr(line).replace(/\s+/g, " ");
    for (const match of text.matchAll(/(?<![\d.,])(\d{1,3}) ?[x×-] ?(\d{1,3})(?![\d.,])/g)) {
      const before = text.slice(0, match.index).trimEnd();
      const after = text.slice(match.index + match[0].length).trimStart();
      const between = (first: string, second: string) => endsWithWord(before, first) && startsWithWord(after, second);
      if (between(home, away) || between(away, home)) return { home: Number(match[1]), away: Number(match[2]) };
    }
  }
  return null;
}

/**
 * Placares do jogo que o post traz: o da entrada ao vivo e o escrito entre os
 * nomes dos times. Aqui só dizem a escala do esporte; o placar que liquida é
 * o da entrada, lido com as regras dele.
 */
export function postScores(
  bet: { evento: string; liveScoreHome?: number | null; liveScoreAway?: number | null },
  caption: string,
): LiveScoreAtTip[] {
  const between = scoreBetweenTeams(bet.evento, caption);
  return [
    ...(bet.liveScoreHome != null && bet.liveScoreAway != null ? [{ home: bet.liveScoreHome, away: bet.liveScoreAway }] : []),
    ...(between ? [between] : []),
  ];
}

/** A linha e o placar do post: o que diz a escala do jogo. */
export type GameScaleTerms = Partial<TotalLineTerms> & { evento: string; scores?: readonly LiveScoreAtTip[] };

function lineTerms(terms: GameScaleTerms): TotalLineTerms {
  return { ...terms, mercado: terms.mercado ?? "", selecao: terms.selecao ?? "" };
}

/**
 * O handicap ou o placar lido do post fora da escala do esporte: discordam
 * dele, sem provar outro (San Marino +6.5 existe no futebol).
 */
function handicapOrScoreOutOfScale(sport: CanonicalSport, terms: GameScaleTerms): boolean {
  return handicapLineImplausible(sport, lineTerms(terms)) ||
    (sport === "Soccer" && (terms.scores ?? []).some((score) => score.home + score.away > SOCCER_MAX_PLAUSIBLE_GOALS));
}

/** A linha de total ou de handicap, ou o placar lido do post, fora da escala do esporte. */
function outOfSportScale(sport: CanonicalSport, terms: GameScaleTerms): boolean {
  return totalLineImplausible(sport, lineTerms(terms)) || handicapOrScoreOutOfScale(sport, terms);
}

/**
 * Futebol que só a liga compartilhada apoia ("Serie A", "Premier League"):
 * não prova o esporte quando a leitura do post aponta outro ou quando a
 * linha ou o placar saem da escala do futebol. Aí decide quem acha o jogo.
 */
export function sharedSoccerLeagueRefuted(
  decision: Pick<SportResolutionDecision, "sport" | "evidence">,
  terms: GameScaleTerms,
  postSports: readonly CanonicalSport[] = [],
): boolean {
  if (decision.sport !== "Soccer") return false;
  if (!decision.evidence.every((item) => item.source === "COMPETITION" && SHARED_SOCCER_LEAGUE.test(item.value))) return false;
  return postSports.some((sport) => sport !== "Soccer") || outOfSportScale("Soccer", terms);
}

/**
 * A identidade local diz de que esporte são os NOMES, não o jogo: clube de
 * futebol e de basquete dividem nome. Por isso o esporte dela passa pelas
 * guardas do post: o texto, o emoji ou a competição do post em outro
 * esporte, a IA a partir de 70 (`refutingPostSports`) ou a linha e o placar
 * fora da escala (`outOfSportScale`) desmentem a identidade.
 */
export function teamIdentityContradicted(
  sport: CanonicalSport,
  bet: GameScaleTerms,
  postSports: readonly CanonicalSport[],
): boolean {
  return postSports.some((other) => other !== sport) || outOfSportScale(sport, bet);
}

/** O candidato desmentido fica na evidência, mas abaixo do limiar e marcado: não vota. */
function contradictedCandidate(candidate: SportCandidate, strategy: string): SportCandidate {
  return {
    ...candidate,
    confidence: Math.min(candidate.confidence, LOCAL_IDENTITY_CANDIDATE_CONFIDENCE),
    strategy: `${candidate.strategy ?? strategy}${CONTRADICTED_STRATEGY_SUFFIX}`,
  };
}

/** Candidato da identidade local (o par de times nas fichas) que o post ou a linha desmentem. */
export function guardIdentityCandidate(
  candidate: SportCandidate,
  bet: GameScaleTerms,
  postSports: readonly CanonicalSport[],
): SportCandidate {
  return teamIdentityContradicted(candidate.sport, bet, postSports) ? contradictedCandidate(candidate, "identity") : candidate;
}

/**
 * A linha que o futebol não tem: total de 50 ou mais, ou o placar em outra
 * unidade (pontos, sets, games). A estatística (cartões, escanteios) tem
 * outra escala e fica de fora.
 */
function lineRefutesSoccer(terms: TotalLineTerms): boolean {
  if (hasNonScoreStatQualifier(terms.mercado, terms.selecao)) return false;
  return totalLineImplausible("Soccer", terms) || hasScoreUnitMismatch(terms.mercado, terms.selecao, "Soccer");
}

/**
 * O jogo de futebol que o catálogo achou para uma linha que o futebol não tem
 * ("Over 160.5", "Handicap de Pontos") é o do clube homônimo: Real Madrid e
 * Barcelona também jogam basquete. Só o futebol é desmentido assim: um total
 * baixo ou os pontos não provam que o jogo não é de basquete (quarto) ou de
 * vôlei (pontos do jogo).
 */
export function guardSoccerGameCandidate(candidate: SportCandidate, lines: readonly TotalLineTerms[]): SportCandidate {
  return candidate.sport === "Soccer" && lines.some(lineRefutesSoccer)
    ? contradictedCandidate(candidate, candidate.provider ?? "catalog")
    : candidate;
}

/**
 * Esportes que o dono marcou no canal. Um só confirma a captura que não tem
 * evidência contrária; vários restringem os candidatos. A leitura do post
 * (texto, emoji, competição, IA) em outro esporte vira conflito para revisão,
 * mesmo a IA fraca, e o total fora da escala do esporte também (a linha é de
 * outra unidade). O handicap e o placar fora da escala só discordam: o canal
 * não confirma, e o resolvedor procura o jogo. A identidade dos times não
 * discorda do canal: ela diz onde os nomes existem, e o dono disse o que o
 * canal posta. A IA que o texto do post desmente não conta (`postSignals`).
 */
/**
 * Os esportes marcados no canal sobre a decisão lida do post: com um só, que
 * nada desmente, a aposta fica nele. Vale na captura e, para a aposta que já
 * estava pendente quando o dono marcou o canal, no resolvedor.
 */
export function applyChannelSports(
  decision: SportResolutionDecision,
  channelSports: readonly CanonicalSport[],
  bet: GameScaleTerms,
): SportResolutionDecision {
  if (channelSports.length === 0) return decision;
  const evidence = [...decision.evidence, ...channelEvidence(channelSports)];
  if (decision.status === "CONFLICT") return { ...decision, evidence };
  if (decision.status === "CONFIRMED" && decision.sport) {
    return channelSports.includes(decision.sport) ? decision : unresolvedSportDecision("CONFLICT", evidence);
  }
  const contradicts = (decision.sport !== null && !channelSports.includes(decision.sport)) ||
    postSignalSports(decision.evidence).some((sport) => !channelSports.includes(sport));
  if (contradicts) return unresolvedSportDecision("CONFLICT", evidence);
  const [only] = channelSports;
  if (channelSports.length === 1 && only) {
    if (totalLineImplausible(only, lineTerms(bet))) return unresolvedSportDecision("CONFLICT", evidence);
    if (handicapOrScoreOutOfScale(only, bet)) return { ...decision, evidence };
    return {
      sport: only,
      status: "CONFIRMED",
      confidence: CHANNEL_SPORT_CONFIDENCE,
      source: "CHANNEL",
      evidence,
      resolverVersion: SPORT_RESOLVER_VERSION,
    };
  }
  return { ...decision, evidence };
}

/**
 * A identidade local dos times não confirma a captura, nem o par com id
 * externo (`findTeamIdentitySportCandidates` a deixa abaixo de 70): quem
 * confirma é o que acha o jogo, no resolvedor. Na captura ela só serve ao
 * canal: time homônimo em vários esportes, com um só dentro dos esportes do
 * canal que o post e a linha não desmentem, fica nele. Sem essa escolha, null.
 */
async function channelHomonymDecision(
  bet: ParsedBetPost & { scores: readonly LiveScoreAtTip[] },
  syncDecision: SportResolutionDecision,
  channelSports: readonly CanonicalSport[],
): Promise<SportResolutionDecision | null> {
  if (channelSports.length === 0) return null;
  const { findTeamIdentitySportCandidates } = await import(
    "@/src/services/bets/sport-resolution/team-candidates"
  );
  const postSports = refutingPostSports(postSignals(syncDecision.evidence));
  const found = (await findTeamIdentitySportCandidates(bet.evento, {
    pais: bet.pais,
    competicao: bet.competicao,
  })).map((candidate) => guardIdentityCandidate(candidate, bet, postSports));
  const picked = channelPicksHomonym(found, channelSports);
  if (!picked) return null;
  return {
    sport: picked,
    status: "CONFIRMED",
    confidence: CHANNEL_SPORT_CONFIDENCE,
    source: "CHANNEL",
    evidence: [
      ...syncDecision.evidence,
      ...found.map((candidate): SportEvidence => ({
        source: "TEAM_ID", sport: candidate.sport, confidence: candidate.confidence, value: bet.evento,
      })),
      ...channelEvidence(channelSports),
    ],
    resolverVersion: SPORT_RESOLVER_VERSION,
  };
}

export async function resolveSportForCaptureAsync(params: {
  bet: ParsedBetPost;
  caption: string;
  /** Esportes do canal (Config › Tipsters); vazio = "vários/não sei". */
  channelSports?: readonly string[];
}): Promise<SportResolutionDecision> {
  const channelSports = canonicalChannelSports(params.channelSports);
  const syncDecision = resolveSportForCapture(params);
  const bet = { ...params.bet, scores: postScores(params.bet, params.caption) };
  if (
    (syncDecision.status === "CONFIRMED" && syncDecision.confidence >= SPORT_AUTO_CONFIRM_MIN_CONFIDENCE) ||
    syncDecision.status === "CONFLICT" ||
    !params.bet.evento
  ) {
    return applyChannelSports(syncDecision, channelSports, bet);
  }
  // Consulta local, sem rede: a falha dela mantém a decisão síncrona.
  const byHomonym = await channelHomonymDecision(bet, syncDecision, channelSports).catch(() => null);
  return applyChannelSports(byHomonym ?? syncDecision, channelSports, bet);
}

export function sportStoredValue(decision: SportResolutionDecision): string {
  return decision.status === "CONFIRMED" && decision.sport
    ? decision.sport
    : UNKNOWN_SPORT;
}
