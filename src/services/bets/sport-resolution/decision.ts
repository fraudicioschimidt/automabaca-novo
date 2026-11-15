import type { Prisma } from "@/src/generated/prisma/client";
import { canonicalCompetition, canonicalCountry } from "@/src/domain/national-teams";
import { canonicalSport, type CanonicalSport } from "@/src/domain/sports/registry";
import {
  detectSportFromText,
  SPORT_AUTO_CONFIRM_MIN_CONFIDENCE,
  SPORT_DISSENT_MIN_CONFIDENCE,
} from "@/src/domain/sports/detect";
import { normalizeStr } from "@/src/domain/text";
import type { SportCandidate, SportDissent, SportSignal } from "./types";
import { separateCompactStatUnit } from "@/src/domain/mercados/total-direction";
import { isBttsMarket } from "@/src/domain/mercados/classify";

/**
 * Decisão PURA da modalidade: dado o conjunto de candidatos, quem vence e se
 * há conflito. Sem I/O, para a regra ser testada sem prisma, providers nem fila.
 */

type ParsedCaptureEvidence = {
  esporte?: unknown;
  mercado?: unknown;
  selecao?: unknown;
  competicao?: unknown;
  pais?: unknown;
  evento?: unknown;
  sportResolution?: {
    sport?: unknown;
    evidence?: Array<{ sport?: unknown; source?: unknown; confidence?: unknown }>;
  };
};

export function jsonObject(value: Prisma.JsonValue | null): ParsedCaptureEvidence {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ParsedCaptureEvidence)
    : {};
}

export function candidateHints(parsed: ParsedCaptureEvidence): CanonicalSport[] {
  const hints = new Set<CanonicalSport>();
  // Mercado é pista para ordenar a busca, não prova suficiente para confirmar esporte.
  const marketText = separateCompactStatUnit(`${parsed.mercado ?? ""} ${parsed.selecao ?? ""}`);
  if (/\b(?:cantos?|corners?|escanteios?)\b/i.test(marketText)) hints.add("Soccer");
  const direct = canonicalSport(
    typeof parsed.sportResolution?.sport === "string"
      ? parsed.sportResolution.sport
      : typeof parsed.esporte === "string"
        ? parsed.esporte
        : null,
  );
  if (direct) hints.add(direct);
  for (const evidence of parsed.sportResolution?.evidence ?? []) {
    const sport = canonicalSport(
      typeof evidence.sport === "string" ? evidence.sport : null,
    );
    if (sport) hints.add(sport);
  }
  if (typeof parsed.competicao === "string" && parsed.competicao.trim()) {
    const detected = detectSportFromText(parsed.competicao);
    if (detected.sport && detected.confidence >= 90) {
      hints.add(detected.sport);
    }
  }
  // Ambas marcam existe no hóquei: pista depois do esporte que a leitura deu.
  if (isBttsMarket(marketText)) hints.add("Soccer");
  return [...hints];
}

/**
 * A identidade dos times é pista: o par de nomes nas fichas dos times, o
 * homônimo em mais de um esporte e o par que o post ou a linha desmentem. Fica
 * abaixo de `SPORT_DISSENT_MIN_CONFIDENCE`: não confirma nem segura a
 * confirmação de outra fonte. O nome existe na base, mas Flamengo, Botafogo, Real Madrid e Barcelona têm futebol e basquete.
 */
export const LOCAL_IDENTITY_CANDIDATE_CONFIDENCE = 60;

/** Par completo de times achado em mais de um esporte. */
export const HOMONYM_PAIR_STRATEGY = "homonym_pair";

/** Sufixo da estratégia do candidato local que o post ou a linha desmentem. */
export const CONTRADICTED_STRATEGY_SUFFIX = "_contradicted";

/**
 * Time homônimo em vários esportes: os esportes do canal escolhem quando, dos
 * homônimos que o post não desmente, sobra exatamente um dentro do canal.
 */
export function channelPicksHomonym(
  candidates: readonly Pick<SportCandidate, "sport" | "strategy">[],
  channelSports: readonly CanonicalSport[],
): CanonicalSport | null {
  const homonyms = candidates.filter((candidate) => candidate.strategy?.startsWith(HOMONYM_PAIR_STRATEGY));
  if (channelSports.length === 0 || new Set(homonyms.map((candidate) => candidate.sport)).size < 2) return null;
  const inside = new Set(homonyms
    .filter((candidate) => candidate.strategy === HOMONYM_PAIR_STRATEGY && channelSports.includes(candidate.sport))
    .map((candidate) => candidate.sport));
  const [only] = inside;
  return inside.size === 1 && only ? only : null;
}

/** Fontes que acham o JOGO, e não só os nomes: os catálogos. */
function findsTheGame(candidate: SportCandidate): boolean {
  return candidate.provider === "flashscore" || candidate.provider === "pinnacle17" || candidate.provider === "bridgeodds";
}

/**
 * A evidência que vota. A que o post ou a linha desmentem
 * (`CONTRADICTED_STRATEGY_SUFFIX`) não vota, e a identidade dos times (o par
 * de nomes nas fichas e o homônimo) cala quando uma fonte achou o
 * jogo: o nome diz em que esporte o clube existe, o jogo diz qual é o jogo.
 */
export function votingCandidates(candidates: readonly SportCandidate[]): SportCandidate[] {
  const voting = candidates.filter((candidate) => !candidate.strategy?.endsWith(CONTRADICTED_STRATEGY_SUFFIX));
  if (!voting.some(findsTheGame)) return voting;
  return voting.filter((candidate) => candidate.provider !== "team_identity" || findsTheGame(candidate));
}

/** Se a fonte devolveu um valor que não é o da pergunta, comparado pelo canônico. */
function addedBySource(
  found: string | null | undefined,
  asked: string | null | undefined,
  canonical: (value: string) => string,
): boolean {
  if (!found?.trim()) return false;
  if (!asked?.trim()) return true;
  return normalizeStr(canonical(found)) !== normalizeStr(canonical(asked));
}

/** Os termos da aposta que a busca na web recebe na pergunta. */
type SportSearchTerms = { competicao?: string | null; pais?: string | null; kickoffInferido?: boolean };

/**
 * A busca web recebe a competição e o país da aposta na pergunta: só conta o
 * que a fonte acrescentou, comparado pelo canônico para que a tradução
 * ("Espanha" → "Spain") não passe por novidade. O horário ela sempre traz; só
 * acrescenta algo quando o da aposta era estimado.
 */
function webAddedDetail(candidate: SportCandidate, bet: SportSearchTerms): boolean {
  const addedCountry = addedBySource(candidate.country, bet.pais, canonicalCountry);
  const addedCompetition = addedBySource(candidate.competition, bet.competicao, (value) =>
    canonicalCompetition(value, candidate.country ?? bet.pais ?? undefined));
  return addedCountry || addedCompetition || Boolean(bet.kickoffInferido && candidate.kickoffIso);
}

const TEXT_SOURCES = new Set(["TEXT", "EMOJI", "COMPETITION"]);

/**
 * A leitura do post que vota. A IA que o texto desmente (o texto, o emoji ou
 * a competição, do post ou dos termos da aposta, apontam outro esporte) não
 * conta: ler o esporte no texto é prova, e a IA é palpite.
 */
export function votingPostSignals(
  signals: readonly SportSignal[],
  textEvidence: readonly Pick<SportSignal, "sport" | "source">[] = [],
): SportSignal[] {
  const inText = new Set([...signals, ...textEvidence].filter((item) => TEXT_SOURCES.has(item.source)).map((item) => item.sport));
  return signals.filter((signal) => signal.source !== "LLM" || inText.size === 0 || inText.has(signal.sport));
}

function isWeb(candidate: SportCandidate): boolean {
  return candidate.provider === "web" || candidate.source === "WEB";
}

function strongest<T extends { confidence: number }>(list: readonly T[]): T | undefined {
  return [...list].sort((left, right) => right.confidence - left.confidence)[0];
}

function candidateDissent(candidate: SportCandidate): SportDissent {
  return {
    sport: candidate.sport, confidence: candidate.confidence, source: candidate.source, fromPost: false,
    ...(candidate.provider ? { provider: candidate.provider } : {}),
    ...(candidate.strategy ? { strategy: candidate.strategy } : {}),
  };
}

export type SportChoiceReason =
  | "confirmed"
  | "no_strong_candidate"
  | "strong_candidates_disagree"
  | "post_dissent"
  | "candidate_dissent"
  | "web_without_detail";

export type SportChoice = {
  candidate: SportCandidate | null;
  conflict: boolean;
  reason: SportChoiceReason;
  /** O candidato forte que não confirmou: segurado por discordância ou pela web sem detalhe. */
  leader?: SportCandidate;
  /** Quem discordou, quando foi isso que segurou a confirmação. */
  dissent?: SportDissent;
};

/**
 * O critério único da confirmação automática, na captura e no resolvedor:
 *
 * - confirma o esporte S com evidência de 90 ou mais e nenhum outro esporte a
 *   partir de 70;
 * - a web só confirma com detalhe que a fonte acrescentou (`webAddedDetail`);
 * - dois esportes com 90 ou mais: conflito, para o dono;
 * - outro esporte abaixo de 90 vindo da leitura do post (`postSignals`):
 *   conflito, para o dono; vindo de candidato: pendente, à espera de mais
 *   evidência;
 * - a evidência desmentida não vota (`votingCandidates`).
 *
 * A leitura do post só discorda: quem confirma com ela é a captura.
 */
export function chooseSportCandidate(
  candidates: readonly SportCandidate[],
  context: { postSignals?: readonly SportSignal[]; bet?: SportSearchTerms } = {},
): SportChoice {
  const voting = votingCandidates(candidates);
  const strong = voting.filter((candidate) => candidate.confidence >= SPORT_AUTO_CONFIRM_MIN_CONFIDENCE);
  const leader = strongest(strong);
  if (!leader) return { candidate: null, conflict: false, reason: "no_strong_candidate" };
  const sport = leader.sport;
  const otherStrong = strongest(strong.filter((candidate) => candidate.sport !== sport));
  if (otherStrong) {
    return { candidate: null, conflict: true, reason: "strong_candidates_disagree", leader, dissent: candidateDissent(otherStrong) };
  }
  const postDissent = strongest(votingPostSignals(context.postSignals ?? [], voting).filter((signal) =>
    signal.sport !== sport && signal.confidence >= SPORT_DISSENT_MIN_CONFIDENCE));
  if (postDissent) {
    return {
      candidate: null, conflict: true, reason: "post_dissent", leader,
      dissent: { sport: postDissent.sport, confidence: postDissent.confidence, source: postDissent.source, fromPost: true },
    };
  }
  const dissent = strongest(voting.filter((candidate) =>
    candidate.sport !== sport && candidate.confidence >= SPORT_DISSENT_MIN_CONFIDENCE));
  if (dissent) return { candidate: null, conflict: false, reason: "candidate_dissent", leader, dissent: candidateDissent(dissent) };

  const confirming = strong.filter((candidate) => !isWeb(candidate) || (context.bet && webAddedDetail(candidate, context.bet)));
  const best = strongest(confirming);
  if (!best) return { candidate: null, conflict: false, reason: "web_without_detail", leader };
  const providers = new Set(confirming.map((candidate) => candidate.provider));
  if (providers.has("flashscore") && providers.has("pinnacle17") && best.confidence < 100) {
    return {
      candidate: { ...best, confidence: 98, source: "PROVIDER", strategy: "two_provider_agreement" },
      conflict: false,
      reason: "confirmed",
    };
  }
  return { candidate: best, conflict: false, reason: "confirmed" };
}

/** O que a captura leu no post e a decisão que ela tomou com isso. */
export type CaptureSportEvidence = {
  status: "PENDING" | "CONFLICT";
  signals: unknown[];
};

/**
 * A evidência de esporte gravada pela captura. Até o resolvedor passar,
 * `sportEvidence` é o array de sinais e o status da aposta é o da captura;
 * depois, ela fica em `capture`, dentro do objeto do resolvedor.
 */
export function captureSportEvidence(bet: {
  sportEvidence: unknown;
  sportResolutionStatus: string;
}): CaptureSportEvidence | null {
  if (Array.isArray(bet.sportEvidence)) {
    const status = bet.sportResolutionStatus;
    return status === "PENDING" || status === "CONFLICT" ? { status, signals: bet.sportEvidence } : null;
  }
  if (!bet.sportEvidence || typeof bet.sportEvidence !== "object") return null;
  const capture = (bet.sportEvidence as { capture?: unknown }).capture;
  if (!capture || typeof capture !== "object") return null;
  const { status, signals } = capture as { status?: unknown; signals?: unknown };
  return (status === "PENDING" || status === "CONFLICT") && Array.isArray(signals) ? { status, signals } : null;
}

/**
 * Conflito que a captura apontou (esporte do post contra o do canal, dois
 * esportes no post, linha de total fora da escala): é para o dono revisar, e
 * nenhum candidato de provedor o desfaz sozinho.
 */
export function bornInSportConflict(bet: { sportEvidence: unknown; sportResolutionStatus: string }): boolean {
  return captureSportEvidence(bet)?.status === "CONFLICT";
}

/**
 * Resultado/edição pode chegar depois do kickoff. O catálogo histórico ainda
 * é evidência válida por sete dias; bloquear no primeiro minuto pós-jogo
 * tornava impossível recuperar automaticamente a liquidação já recebida.
 */
export const SPORT_RESOLUTION_HISTORY_WINDOW_MS = 7 * 86_400_000;

export function sportResolutionWindowOpen(params: {
  kickoff: Date;
  kickoffInferido: boolean;
  now: Date;
}): boolean {
  return (
    params.kickoffInferido ||
    params.now.getTime() - params.kickoff.getTime() <= SPORT_RESOLUTION_HISTORY_WINDOW_MS
  );
}
