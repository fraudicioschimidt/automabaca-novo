import "server-only";
import { instanteDaEntrada } from "@/src/domain/instante-da-entrada";
import { formatDurationMinutes, formatSpDateWithYear, formatSpDateTime, formatSpTime, spDayKey } from "@/src/domain/dates";
import type { BetRowData } from "@/src/domain/bet-read-model";
import { fechamentoConfirmado, missingClvReason, noOddsReasonLabel } from "@/src/domain/no-odds-reason";
import { situacaoDoClv } from "@/src/domain/analyzer/cobertura";
import { tipoDeMovimento } from "@/src/domain/analyzer/steam";
import { statusDeTela, type StatusDeTela } from "@/src/domain/status-de-aposta";
import { persistedLiveScoreAtTipText } from "@/src/domain/live-score-at-tip";
import { comparableUsdLiquidity } from "@/src/domain/liquidity";
import { admitsAsianFractionalSettlement } from "@/src/domain/settlement/half-guard";
import { betPostLink, captureOriginLabel } from "@/src/domain/telegram-source";
import { captureReadingOf, type CaptureReading } from "@/src/domain/bet-capture";
import { getBetCaptureOrigin, getBetDetail } from "@/src/services/painel/queries/bet-rows";
import { describeRemovals, type BetRemoval, type RemovalOrigin } from "@/src/services/bets/remove";
import { percentualContraFair } from "@/src/domain/odds";
import { rotuloStatus } from "@/src/domain/mensagem-operador";
import { propStatLabel } from "@/src/domain/settlement/player-prop-classify";
import { declaredScorePeriod } from "@/src/domain/settlement/markets";
import { rotuloDaFonteDeLiquidacao } from "@/src/domain/trilha-da-aposta";
import { sportsSourceForDisplay } from "@/src/domain/trusted-sports-source-url";
import { AUTOMATIC_RESULT_PROVIDER } from "@/src/providers/coverage";
import { getBetSettlementEvidence, type BetSettlementEvidence } from "@/src/services/painel/aposta/liquidacao";
import { interruptedFinishOf } from "@/src/providers/flashscore/terminal";
import { jsonObject, regulationScoreFromSnapshot } from "@/src/services/settlement/flashscore/observation-store";
import { splitInferredOutcome } from "@/src/services/settlement/flashscore/settle";
import { wentBeyondRegulation } from "@/src/services/settlement/ia-judge/flashscore-evidence";
import { contagem } from "../lib/plural";
import { splitEvento } from "./_evento";

/**
 * Uma aposta (BetRowData) na forma que as telas consomem (`b` + `b.d.*`): o
 * detalhe da banca (BETS) e a ficha /aposta?id=. Mock: app/_design/mock/bet.ts.
 */

// "2.5 h antes" — quanto antes do kickoff a aposta foi capturada, na mesma
// escrita de duração das outras telas; null se depois.
function leadBefore(kickoff: Date, captured: Date, kickoffInferido?: boolean): string | null {
  if (kickoffInferido) return null;
  const min = Math.round((kickoff.getTime() - captured.getTime()) / 60_000);
  if (min <= 0) return null;
  return `${formatDurationMinutes(min)} antes`;
}

// Minutos DEPOIS do apito; null quando o registro é pré-jogo. É o número que
// explica um CLV ausente por `aposta_ao_vivo` — sem ele a ficha só diz "não se
// aplica" e o operador não tem como conferir.
function minutosAposApito(kickoff: Date, captured: Date, kickoffInferido?: boolean): number | null {
  if (kickoffInferido) return null;
  const min = Math.round((captured.getTime() - kickoff.getTime()) / 60_000);
  return min > 0 ? min : null;
}

// Mecanismo da escrita do fechamento, em PT. O enum é técnico (CRON/MANUAL/
// REPROCESS) e vazaria cru na ficha.
const MECANISMO_DE_FECHAMENTO: Record<string, string> = {
  CRON: "captura automática",
  MANUAL: "informado à mão",
  REPROCESS: "repescagem",
};


export function toBet(r: BetRowData) {
  // Resolvida p/ EXIBIÇÃO = tudo que não é PENDING (inclui VOID/CANCELED, cujo
  // lucro é 0 = reembolso). FINAL_BET_STATUSES_SET é p/ MÉTRICA (exclui VOID);
  // aqui o critério é "tem resultado a mostrar", senão o VOID apareceria como
  // pendente na ficha.
  const resolvido = r.status !== "PENDING";
  // CLV e fechamento só são FINAIS quando congelados no kickoff. Antes disso a
  // linha é provisória e ainda se move. `fetchedAt` sozinho não basta: ele marca
  // "já tentou congelar (mesmo sem odd)"; ver `fechamentoConfirmado`.
  const fechamentoExibivel = fechamentoConfirmado(r);
  const closingFinal = r.closingFetchedAt != null && r.clvReliable === true;
  const missingReason = missingClvReason(r);
  const { home, away } = splitEvento(r.evento);
  // Abertura justa → fechamento justo, em %: quanto a linha andou. Queda =
  // mercado a favor da seleção. Odd inválida (≤ 1) não mede movimento.
  const movimento = r.openingOdd != null && fechamentoExibivel && r.closingOdd != null
    ? percentualContraFair(r.closingOdd, r.openingOdd)
    : null;
  const liveScoreAtTip = persistedLiveScoreAtTipText(r);
  return {
    id: r.id,
    settlementView: r.settlementView ?? null,
    bkSlug: r.bkSlug ?? null, // botão "voltar" da ficha → bankroll dono
    day: spDayKey(r.data),
    resultDay: r.settledAt ? spDayKey(r.settledAt) : null,
    time: r.kickoffInferido ? "—" : formatSpTime(r.data),
    resultTime: r.settledAt ? formatSpTime(r.settledAt) : null,
    kickoffInferido: r.kickoffInferido === true,
    home,
    away,
    esporte: r.esporte, // ícone do esporte no histórico (lib/sport-icon)
    sportPending:
      r.esporte === "Unknown" ||
      (r.sportResolutionStatus != null &&
        r.sportResolutionStatus !== "CONFIRMED"),
    region: r.pais,
    league: r.competicao || null,
    market: r.mercado,
    line: r.selecao,
    // O menu de resultado só oferece ½ onde a liquidação o aceita.
    allowsHalfResult: admitsAsianFractionalSettlement(r.mercado, r.selecao),
    liveScoreAtTip,
    odds: r.odds,
    movimento,
    clv: closingFinal ? r.clv : null,
    clvSituacao: situacaoDoClv(r),
    stake: r.stake,
    status: statusDeTela(r.status),
    profit: resolvido ? r.lucro : null,
    d: {
      open: r.openingOdd,
      close: fechamentoExibivel ? r.closingOdd : null,
      liqOpen: comparableUsdLiquidity(r.openingMaxBet, r.openingMaxBetCurrency),
      liqClose: fechamentoExibivel
        ? comparableUsdLiquidity(r.closingMaxBet, r.closingMaxBetCurrency)
        : null,
      eventAt: r.kickoffInferido ? `${formatSpDateWithYear(r.data)} · horário a confirmar` : formatSpDateTime(r.data),
      casa: r.casaDeAposta || null,
      capturedAt: formatSpDateTime(r.registradoEm),
      before: leadBefore(r.data, instanteDaEntrada(r), r.kickoffInferido),
      aposApito: minutosAposApito(r.data, instanteDaEntrada(r), r.kickoffInferido),
      settledAt: r.settledAt ? formatSpDateTime(r.settledAt) : null,
      takenAt: r.takenAt ? formatSpDateTime(r.takenAt) : null,
      contaTitular: r.contaTitular,
      contaApelido: r.contaApelido ?? null,
      liveScoreAtTip,
      origin: captureOriginLabel(r.source),
      msg: null, // o post de origem (texto, leitura e link) vem de getCapturaDaAposta, só na ficha
      moveType: tipoDeMovimento(movimento),
      noOdds: r.sportPendingMessage ?? (missingReason ? noOddsReasonLabel(missingReason) : null),
      // Procedência do CLV: com a cadeia visível (odd cravada → bruta da
      // Pinnacle → fair devigada → CLV) o número se defende ou se denuncia
      // sozinho, e um CLV alto de aposta feita depois do apito não passa batido.
      clvOrigem: {
        cravada: r.odds,
        fechamentoBruto: fechamentoExibivel ? r.closingRawOdd : null,
        fechamentoFair: fechamentoExibivel ? r.closingOdd : null,
        clv: closingFinal ? r.clv : null,
        confiavel: r.clvReliable,
        provider: r.closingProvider ?? null,
        mecanismo: r.closingSource ? (MECANISMO_DE_FECHAMENTO[r.closingSource] ?? r.closingSource) : null,
        congeladoEm: r.closingFetchedAt ? formatSpDateTime(r.closingFetchedAt) : null,
        motivo: r.closingNoOddsReason ? noOddsReasonLabel(r.closingNoOddsReason) : null,
      },
    },
  };
}

/** Uma aposta removida na ficha e na lista "Removidas": quando, por onde, se volta e o que saiu. */
export type BetRemovalView = {
  at: string;
  origin: RemovalOrigin;
  restorable: boolean;
  /** Como estava antes de sair (o que o estorno desfez); null se o registro não guardou. */
  previous: { status: StatusDeTela; profit: number | null } | null;
};

export function toRemovalView(removal: BetRemoval): BetRemovalView {
  const previous = removal.previous;
  return {
    at: formatSpDateTime(removal.at),
    origin: removal.origin,
    restorable: removal.restorable,
    previous: previous
      ? { status: statusDeTela(previous.status), profit: previous.status === "PENDING" ? null : previous.lucro }
      : null,
  };
}

/** A remoção da aposta da ficha; null se ela está na banca. */
export async function getBetRemovalView(betId: string): Promise<BetRemovalView | null> {
  const removal = (await describeRemovals([betId])).get(betId);
  return removal ? toRemovalView(removal) : null;
}

/** A aposta da ficha /aposta?id=, removida ou não; null se não existe. */
export async function getApostaBet(betId: string) {
  const row = await getBetDetail(betId);
  return row ? toBet(row) : null;
}

const LEITURA: Record<CaptureReading, string> = {
  regra: "Lida por regra",
  ia_texto: "Lida por IA, do texto",
  ia_imagem: "Lida por IA, da imagem",
  conversa: "Enviada na conversa com o bot",
};

/** O post de origem na ficha: o texto como chegou, como foi lido e o link. */
export type CapturaDaFicha = { texto: string | null; leitura: string | null; link: string | null };

export function capturaDaFicha(origin: NonNullable<Awaited<ReturnType<typeof getBetCaptureOrigin>>>): CapturaDaFicha | null {
  const link = betPostLink(origin.source, origin.sourceExternalId);
  const { evidence } = origin;
  if (!evidence && !link) return null;
  return {
    texto: evidence?.caption?.trim() || null,
    leitura: evidence
      ? `${LEITURA[captureReadingOf(evidence.parser)]}${evidence.totalUnitFromLine ? " · unidade do total deduzida pela linha (escanteios)" : ""}`
      : null,
    link,
  };
}

/** A captura da ficha /aposta?id=; null para aposta sem post de origem. */
export async function getCapturaDaAposta(betId: string): Promise<CapturaDaFicha | null> {
  const origin = await getBetCaptureOrigin(betId);
  return origin ? capturaDaFicha(origin) : null;
}


/**
 * A prova do resultado na ficha: quem decidiu e com o quê. O placar e o jogo
 * vêm do FlashScore mesmo quando outro decidiu, rotulados como o que ele viu.
 */
export type SettlementCard = {
  /** O mesmo rótulo da trilha: "liquidação automática pelo FlashScore", "IA-Judge automático". */
  source: string;
  at: string;
  /**
   * `decided` é o placar que liquidou; `seen`, o placar do período que o FlashScore
   * viu com outro decidindo; `partial`, a última leitura, sem o fim do jogo.
   */
  score: { value: string; kind: "decided" | "seen" | "partial"; period?: "HT"; detail: string | null } | null;
  /** O jogo casado no FlashScore, na ordem da aposta, e a confiança do casamento. */
  fixture: string | null;
  /** Como o FlashScore chegou ao resultado, quando foi ele que liquidou. */
  outcome: string | null;
  /** A estatística do jogador que decidiu uma prop ou um artilheiro. */
  player: string | null;
  /** A conferência depois da liquidação: IA × FlashScore, ou a rechecagem. */
  crossCheck: string | null;
  judge: {
    found: string;
    confidence: string;
    link: string | null;
    site: string | null;
    /** Sem busca na web: a IA julgou (ou o snapshot decidiu) com os dados do FlashScore. */
    fromFlashscore: boolean;
    reason: string;
    /** null quando a regra sobre o snapshot do FlashScore decidiu, sem modelo. */
    model: string | null;
  } | null;
};

/** `settlementOutcome` da liquidação pelo FlashScore; o código sem rótulo aparece cru. */
const FLASHSCORE_OUTCOME_LABEL: Record<string, string> = {
  settled_from_score: "pelo placar final",
  settled_from_regulation_score: "pelo placar do tempo regulamentar",
  settled_from_stats: "pela estatística do jogo",
  settled_from_goalscorer: "pelos gols do jogador",
  settled_from_goalscorer_period: "pelos gols do jogador no período",
  settled_from_ordered_goalscorer: "pela ordem dos gols",
  settled_from_player_prop: "pela estatística do jogador",
  settled_from_basketball_first_half: "pelo placar do 1º tempo",
  refunded: "jogo cancelado ou adiado, reembolso",
};

/** A conferência do IA-Judge pelo FlashScore (`reportIaCrossCheck`). */
const JUDGE_CROSSCHECK_LABEL: Record<string, string> = {
  crosscheck_agrees: "o FlashScore confirmou o resultado da IA",
  crosscheck_diverges: "o FlashScore dá outro resultado; a divergência foi avisada",
  crosscheck_extra_time: "o FlashScore não confere: o jogo foi à prorrogação ou aos pênaltis",
  crosscheck_interrupted: "o FlashScore não confere: o jogo não foi até o fim",
  crosscheck_not_comparable: "o FlashScore não confere este mercado",
};

/** A rechecagem da liquidação por inferência (`flashscore/recheck.ts`); a divergente diz o que leu. */
const INFERRED_RECHECK_LABEL: Record<string, string> = {
  confere: "a rechecagem horas depois confirmou o placar",
  partida_ausente: "a rechecagem não achou mais o jogo no FlashScore",
  sem_base: "a rechecagem não teve o placar liquidado para comparar",
};

/** O `valueFound` da sugestão de jogo não disputado (`flashscore-status`). */
const NOT_PLAYED_LABEL: Record<string, string> = { cancelled: "jogo cancelado", postponed: "jogo adiado" };

type ScorePair = { home: number; away: number };

type Snapshot = Record<string, unknown> | null;

function scorePairOf(value: unknown): ScorePair | null {
  const pair = jsonObject(value);
  return pair && Number.isInteger(pair.home) && Number.isInteger(pair.away)
    ? { home: pair.home as number, away: pair.away as number }
    : null;
}

const formatPair = (pair: ScorePair) => `${pair.home}-${pair.away}`;

/** O estágio cru do FlashScore ("2nd Half", "After Penalties"), citado como nos alertas. */
function withStage(text: string, snapshot: Snapshot): string {
  return typeof snapshot?.stage === "string" && snapshot.stage ? `${text} · FlashScore: "${snapshot.stage}"` : text;
}

function cardScore(
  evidence: BetSettlementEvidence,
  snapshot: Snapshot,
  outcome: string,
  decided: boolean,
): SettlementCard["score"] {
  // Na múltipla o par gravado é só o do primeiro jogo.
  if (snapshot?.ticket === true) return null;
  const { result } = evidence;
  const firstHalf = scorePairOf(jsonObject(snapshot?.basketballFirstHalf)?.score);
  if (firstHalf) {
    return { value: formatPair(firstHalf), kind: decided ? "decided" : "seen", period: "HT", detail: null };
  }
  const listed = scorePairOf(snapshot?.score);
  const stored = result?.scoreHome != null && result.scoreAway != null
    ? { home: result.scoreHome, away: result.scoreAway }
    : null;
  const pair = stored ?? regulationScoreFromSnapshot(snapshot) ?? listed;
  if (!pair) return null;
  // O placar gravado só existe com o jogo encerrado. O do snapshot vale como
  // final com a observação fechada ou a flag de fim do fornecedor; fora isso é
  // a última leitura, que a liquidação manual congela no meio do jogo.
  if (!stored && !result?.final && snapshot?.finished !== true) {
    return { value: formatPair(pair), kind: "partial", detail: withStage("fim do jogo não confirmado", snapshot) };
  }
  // Sem a prova parcial, o FT observado não decide um mercado de período.
  const decidedByThisScore = decided && declaredScorePeriod(evidence.terms) === "FT";
  return { value: formatPair(pair), kind: decidedByThisScore ? "decided" : "seen", detail: finalScoreDetail(snapshot, pair, listed, outcome) };
}

function finalScoreDetail(snapshot: Snapshot, pair: ScorePair, listed: ScorePair | null, outcome: string): string | null {
  if (!snapshot) return null;
  // Abandono, W.O. e resultado decidido fora de campo: o feed marca o fim, e o
  // placar é o do momento em que o jogo parou.
  if (typeof snapshot.stage === "string" && interruptedFinishOf(snapshot.stage)) {
    return withStage("jogo não concluído", snapshot);
  }
  if (listed && formatPair(listed) !== formatPair(pair)) return `listado ${formatPair(listed)}, com a prorrogação`;
  // Sem os 90' reconstruídos, o placar listado inclui a prorrogação: o estágio
  // avisa. A conferência do IA-Judge recusa também pela flag, que o snapshot não guarda.
  return outcome === "crosscheck_extra_time" || wentBeyondRegulation(snapshot)
    ? withStage("o jogo passou do tempo normal", snapshot)
    : null;
}

function fixtureOf(snapshot: Snapshot, confidence: number | null | undefined): string | null {
  const teams = jsonObject(snapshot?.providerTeams);
  if (typeof teams?.home !== "string" || typeof teams.away !== "string") return null;
  // Na ordem da aposta, a mesma do placar: `swapped` diz que o feed lista ao contrário.
  const name = teams.swapped === true ? `${teams.away} vs ${teams.home}` : `${teams.home} vs ${teams.away}`;
  return confidence == null ? name : `${name} · casamento ${Math.round(confidence * 100)}%`;
}

function flashscoreOutcome(snapshot: Snapshot, outcome: string, inferred: boolean, terms: BetSettlementEvidence["terms"]): string | null {
  const period = declaredScorePeriod(terms);
  const periodLabel = outcome === "settled_from_score" || outcome === "settled_from_regulation_score"
    ? period === "HT" ? "pelo placar do 1º tempo" : period === "SECOND_HALF" ? "pelo placar do 2º tempo" : null
    : null;
  const label = snapshot?.ticket === true ? ticketOutcome(snapshot) : periodLabel ?? (outcome ? (FLASHSCORE_OUTCOME_LABEL[outcome] ?? outcome) : null);
  return label && inferred ? `${label}; o fim do jogo foi deduzido, não marcado pelo FlashScore` : label;
}

/**
 * O snapshot do bilhete conta os jogos com placar e os cancelados: uma perna
 * perdida decide a múltipla antes de os outros jogos acabarem.
 */
function ticketOutcome(snapshot: Record<string, unknown>): string | null {
  const count = (key: string) => {
    const value = snapshot[key];
    return typeof value === "number" ? value : 0;
  };
  const fixtures = count("fixtures");
  const scored = count("scored");
  const cancelled = count("cancelled");
  if (fixtures === 0) return null;
  if (cancelled === fixtures) return "jogos cancelados ou adiados, reembolso";
  const byScore = scored === fixtures
    ? `pelos placares dos ${contagem(fixtures, "jogo")} da múltipla`
    : `${scored === 1 ? "pelo placar" : "pelos placares"} de ${scored} dos ${contagem(fixtures, "jogo")} da múltipla`;
  return cancelled > 0
    ? `${byScore}; ${contagem(cancelled, "jogo cancelado ou adiado", "jogos cancelados ou adiados")}`
    : byScore;
}

/** "Raphinha · 3 chutes no gol" de uma prova da prop persistida (`settlePersistentPlayerProp`). */
function propReading(proof: Record<string, unknown>): string | null {
  const decision = jsonObject(proof.decision);
  if (decision?.ok !== true || typeof proof.playerName !== "string") return null;
  if (typeof decision.value !== "number") return `${proof.playerName} não foi titular`;
  return typeof proof.family === "string"
    ? `${proof.playerName} · ${decision.value} ${propStatLabel(proof.family, decision.value)}`
    : `${proof.playerName} · ${decision.value}`;
}

/** A prova da prop persistida gravada no snapshot da liquidação, que a rechecagem não toca. */
function settledPropProof(snapshot: Snapshot): Record<string, unknown> | null {
  const prop = jsonObject(snapshot?.playerProp);
  return prop?.resolvido === true ? jsonObject(prop.details) : null;
}

/** O que o FlashScore leu do jogador, na mesma frase do aviso do Telegram. */
function decidingPlayer(evidence: BetSettlementEvidence, snapshot: Snapshot, outcome: string): string | null {
  const proof = settledPropProof(snapshot);
  if (proof) return propReading(proof);
  const prop = jsonObject(snapshot?.playerProp);
  if (prop?.resolvido === true && typeof prop.jogador === "string" && typeof prop.valor === "number") {
    return typeof prop.family === "string"
      ? `${prop.jogador} · ${prop.valor} ${propStatLabel(prop.family, prop.valor)}`
      : `${prop.jogador} · ${prop.valor}`;
  }
  // O artilheiro liquida reembolso quando o jogador não entrou em campo.
  const voided = evidence.status === "VOID";
  const scorer = jsonObject(snapshot?.goalscorer);
  if (scorer?.resolvido === true && typeof scorer.jogador === "string" && typeof scorer.gols === "number") {
    if (voided) return `${scorer.jogador} não entrou em campo`;
    const period = outcome === "settled_from_goalscorer_period" ? declaredScorePeriod(evidence.terms) : "FT";
    const inPeriod = period === "HT" ? " no 1º tempo" : period === "SECOND_HALF" ? " no 2º tempo" : "";
    return `${scorer.jogador} · ${contagem(scorer.gols, "gol")}${inPeriod}`;
  }
  const ordered = jsonObject(snapshot?.orderedGoalscorer);
  if (ordered?.resolvido !== true) return null;
  if (voided && typeof ordered.jogadorSelecionado === "string") return `${ordered.jogadorSelecionado} não entrou em campo`;
  if (typeof ordered.jogadorDoGol !== "string" || typeof ordered.minuto !== "string") return null;
  return `${ordered.ordem === "first" ? "primeiro" : "último"} gol: ${ordered.jogadorDoGol} aos ${ordered.minuto}'`;
}

/**
 * A rechecagem de 24h da prop (`players/maintenance`) regrava
 * `bet_player_prop.evidence` com a leitura dela. Diante da prova da
 * liquidação, o cartão diz se confirmou ou o que ela leu de diferente.
 */
function propRecheck(settledProof: Record<string, unknown> | null, current: unknown): string | null {
  const recheck = jsonObject(current);
  if (!settledProof || recheck?.checked24h !== true) return null;
  const settled = jsonObject(settledProof.decision);
  const read = jsonObject(recheck.decision);
  if (read?.ok === true && read.status === settled?.status && read.value === settled?.value) {
    return "a rechecagem 24h depois confirmou a estatística";
  }
  const reason = typeof read?.reason === "string" ? read.reason : typeof recheck.reason === "string" ? recheck.reason : "sem leitura";
  const reading = read?.ok === true
    ? `a rechecagem 24h depois leu ${propReading(recheck) ?? "outra estatística"}` +
      (read.status === settled?.status ? ", sem mudar o resultado" : ` (${rotuloStatus(String(read.status))})`)
    : `a rechecagem 24h depois não confirmou a estatística (${reason.replaceAll("_", " ")})`;
  if (typeof recheck.divergenceExplanation === "string") return `${reading}; conferida: ${recheck.divergenceExplanation}`;
  return recheck.correctionReview === true ? `${reading}; a divergência está para conferir em Config › Jogadores` : reading;
}

function flashscoreRecheck(snapshot: Snapshot, playerPropEvidence: unknown): string | null {
  const inferred = jsonObject(snapshot?.recheck);
  if (inferred?.resultado === "divergente") {
    const read = typeof inferred.placarAgora === "string"
      ? `leu outro placar, ${feedScoreInBetOrder(inferred.placarAgora, snapshot)}`
      : "achou o jogo sem placar";
    return `a rechecagem horas depois ${read}; a divergência foi avisada`;
  }
  if (typeof inferred?.resultado === "string") return INFERRED_RECHECK_LABEL[inferred.resultado] ?? null;
  return propRecheck(settledPropProof(snapshot), playerPropEvidence);
}

/**
 * A rechecagem grava o placar como o feed lista ("2x1"); o cartão mostra o do
 * jogo na ordem da aposta. A múltipla junta um placar por jogo e fica como veio.
 */
function feedScoreInBetOrder(score: string, snapshot: Snapshot): string {
  const pair = /^(\d+)x(\d+)$/.exec(score);
  if (!pair) return score;
  return jsonObject(snapshot?.providerTeams)?.swapped === true ? `${pair[2]}-${pair[1]}` : `${pair[1]}-${pair[2]}`;
}

export function settlementCardOf(evidence: BetSettlementEvidence): SettlementCard {
  const source = evidence.source ?? "";
  const byFlashscore = source === AUTOMATIC_RESULT_PROVIDER;
  const byJudge = source.startsWith("ia-judge:");
  const snapshot = jsonObject(evidence.result?.snapshot);
  const { outcome, inferred } = splitInferredOutcome(
    typeof snapshot?.settlementOutcome === "string" ? snapshot.settlementOutcome : "",
  );
  const { judge } = evidence;
  const sportsSource = judge ? sportsSourceForDisplay(judge.sourceUrl, judge.groundingSources) : null;
  const fromFlashscore = judge?.evidenceKind === "FLASHSCORE_STRUCTURED";
  // `flashscore-stats` e `flashscore-status` são a regra sobre o snapshot, antes do LLM.
  const byRule = fromFlashscore && judge.provider.startsWith("flashscore-");
  return {
    source: rotuloDaFonteDeLiquidacao(evidence.source),
    at: formatSpDateTime(evidence.changedAt),
    score: cardScore(evidence, snapshot, outcome, byFlashscore),
    fixture: fixtureOf(snapshot, evidence.result?.matchConfidence),
    outcome: byFlashscore ? flashscoreOutcome(snapshot, outcome, inferred, evidence.terms) : null,
    player: byFlashscore ? decidingPlayer(evidence, snapshot, outcome) : null,
    crossCheck: byJudge
      ? (JUDGE_CROSSCHECK_LABEL[outcome] ?? "sem conferência do FlashScore")
      : byFlashscore ? flashscoreRecheck(snapshot, evidence.playerPropEvidence) : null,
    judge: judge
      ? {
          found: fromFlashscore ? (NOT_PLAYED_LABEL[judge.valueFound] ?? judge.valueFound) : judge.valueFound,
          confidence: `${Math.round(judge.confidence * 100)}%`,
          link: sportsSource?.url ?? null,
          site: sportsSource?.domain ?? null,
          fromFlashscore,
          reason: judge.reason,
          model: byRule ? null : judge.provider,
        }
      : null,
  };
}

/** O cartão da liquidação na ficha /aposta?id=; null para aposta pendente ou removida. */
export async function getBetSettlementCard(betId: string): Promise<SettlementCard | null> {
  const evidence = await getBetSettlementEvidence(betId);
  return evidence ? settlementCardOf(evidence) : null;
}
