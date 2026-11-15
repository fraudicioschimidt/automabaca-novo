import { identityEventName } from "@/src/domain/live-score-at-tip";
import { isMercadoFinalForSport } from "@/src/domain/mercados/compatibility";
import { finalizePinnacleMarket } from "@/src/domain/mercados/finalize";
import {
  canonicalCompetition,
  canonicalCountry,
} from "@/src/domain/national-teams";
import { createLogger } from "@/src/infra/logger";
import { recordOperationalMetric } from "@/src/infra/operational-metrics";
import { EnrichObsoleteError, advanceEnrichTerms, lockActiveEnrichBet } from "./write-guard";
import { runSerializableTransaction } from "@/src/services/shared/transaction";
import { parseBridgeLeague, type BridgeMatch } from "@/src/providers/bridgeodds/types";
import { findPinnacle17EventById } from "@/src/providers/pinnacle17/client";
import { pinnacle17SportId } from "@/src/providers/pinnacle17/types";
import { orientPinnacle17Selection, selectionFollowsEventOrder } from "@/src/providers/pinnacle17/sharp";
import { pinnacleEsporteFromBridgeSport } from "@/src/providers/bridgeodds/coverage-contract";
import type { BridgeMatchCandidate } from "@/src/providers/bridgeodds/scoring";
import { learnTipsterTeamNames } from "@/src/services/teams/tipster-names";

const log = createLogger("sharp-enrich");

export type ApplyIdentityBet = {
  id: string;
  odds?: unknown;
  pais?: string;
  competicao?: string;
  /**
   * Identidade resolvida À MÃO tem precedência sobre o provider (MANUAL >
   * AUTO): o re-enrich, frequente em banca `CLV_ONLY`, não reescreve
   * evento, competição e país com o valor da Bridge.
   */
  identityStatus?: string | null;
  evento: string;
  esporte: string;
  mercado: string;
  selecao: string;
  data: Date;
  kickoffInferido: boolean;
};

export type ApplyIdentityResult = {
  esporteCanonico: string;
  competicao: string;
  pais: string;
  mercado: string;
  selecao: string;
  data: Date;
  kickoffInferido: boolean;
  kickoffValido: boolean;
  kickoff: Date;
};

export const STORED_IDENTITY_SELECT = { identityStatus: true, provider: true, providerMatchId: true } as const;

/**
 * O histórico ganha um evento por decisão de identidade do enrich: não quando
 * o dono ou o agente dele já vinculou (essa decisão tem o evento dela), nem
 * quando a reexecução repete o jogo já gravado sem mudar a aposta.
 */
export function identityDecisionIsNew(params: {
  stored: { identityStatus: string; provider: string | null; providerMatchId: string | null } | null;
  provider: string;
  providerMatchId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}): boolean {
  const { stored, before, after } = params;
  if (stored?.identityStatus === "MANUAL") return false;
  const sameMatch = stored?.identityStatus === "MATCHED"
    && stored.provider === params.provider
    && stored.providerMatchId === params.providerMatchId;
  return !sameMatch || Object.keys(after).some((field) => before[field] !== after[field]);
}

/**
 * Grava identidade canônica na Bet, audita a decisão e, no casamento
 * automático, aprende o nome do tipster pela ficha do time.
 */
export async function applyBridgeIdentity(params: {
  bet: ApplyIdentityBet;
  best: BridgeMatchCandidate;
  via: "AUTO" | "LLM";
  teams: { home: string; away: string };
  /** Concordância TEXTUAL dos nomes (0–100). */
  confidence: number;
  /** Certeza do JUIZ, quando foi ele quem decidiu; null no caminho AUTO. */
  judgeConfidence?: number | null;
  /** Horário atual do jogo na Pinnacle17 (`bridgeMatchGameStart`); null sem ela. */
  gameStart: Date | null;
}): Promise<ApplyIdentityResult> {
  const { bet, best, via, teams, confidence } = params;
  const { match, swapped } = best;

  const parsedLeague = parseBridgeLeague(match.league);
  const pais = canonicalCountry(parsedLeague.pais);
  const competicao = canonicalCompetition(parsedLeague.competicao);
  const esporteCanonico = pinnacleEsporteFromBridgeSport(match.sport);

  // O horário do jogo casado é o da Pinnacle17 pelo mesmo id: a Bridge guarda
  // o da primeira listagem e não acompanha remarcação (Palmeiras x São Paulo
  // antecipado 3 h; Bahia x Remo adiado 27 h). Sem a Pinnacle17, o match_date
  // só preenche a aposta sem hora; o horário real da aposta fica.
  const betKickoff = bet.data;
  const matchDate = new Date(match.match_date);
  const kickoff = params.gameStart ?? (bet.kickoffInferido ? matchDate : bet.data);
  const kickoffValido = !Number.isNaN(kickoff.getTime()) && (params.gameStart !== null || bet.kickoffInferido);
  const mercadoCandidate = finalizePinnacleMarket(bet.mercado, esporteCanonico);
  const mercadoFinal = isMercadoFinalForSport(mercadoCandidate, esporteCanonico)
    ? mercadoCandidate
    : bet.mercado;
  const localHome = swapped ? teams.away : teams.home;
  const localAway = swapped ? teams.home : teams.away;
  const { respeitaManual, eventoFinal, selecaoFinal, mercadoMudou, selecaoMudou } = await runSerializableTransaction("bridge.identity-accept", async (tx) => {
    const freshBet = await lockActiveEnrichBet(tx, bet.id);
    const freshSharp = await tx.betSharp.findUnique({
      where: { betId: bet.id },
      select: STORED_IDENTITY_SELECT,
    });
    const respeitaManual = freshSharp?.identityStatus === "MANUAL" || bet.identityStatus === "MANUAL";
    // A seleção que só diz o lado ("Casa") vira o nome do time antes da troca:
    // com o mando trocado, o rótulo passaria a apontar o outro time.
    const selecaoFinal = respeitaManual
      ? bet.selecao
      : orientPinnacle17Selection({
          mercado: bet.mercado,
          selecao: bet.selecao,
          home: teams.home,
          away: teams.away,
          providerHome: match.home,
          providerAway: match.away,
          swapped,
        });
    const eventoFinal = identityEventName({ providerHome: match.home, providerAway: match.away, swapped, ...freshBet,
      selectionFollowsOrder: selectionFollowsEventOrder(bet.mercado, selecaoFinal) });

    // O que o operador resolveu na mão não é reescrito pelo provider; o resto
    // Mercado/kickoff continuam canonizando, mas evento e seleção formam um par:
    // preservar só o evento PT e traduzir a seleção para EN torna o lado
    // irresolvível no settlement.
    const applied = await tx.bet.updateMany({
      where: { id: bet.id, deletedAt: null, evento: bet.evento, mercado: bet.mercado,
        selecao: bet.selecao, data: bet.data,
        ...(bet.pais != null ? { pais: bet.pais } : {}), ...(bet.competicao != null ? { competicao: bet.competicao } : {}),
        ...(bet.odds != null ? { odds: String(bet.odds) } : {}) },
      data: {
        ...(respeitaManual ? {} : {
          evento: eventoFinal,
          competicao,
          pais,
          esporte: esporteCanonico,
        }),
        ...(mercadoFinal !== bet.mercado ? { mercado: mercadoFinal } : {}),
        ...(selecaoFinal !== bet.selecao ? { selecao: selecaoFinal } : {}),
        ...(kickoffValido && !respeitaManual ? { data: kickoff, kickoffInferido: false } : {}),
      },
    });
    if (!applied.count) throw new EnrichObsoleteError();
    // A canonização do MERCADO/SELEÇÃO vira evento próprio, e não uma nota de
    // rodapé do evento de identidade.
    const mercadoMudou = mercadoFinal !== bet.mercado;
    const selecaoMudou = selecaoFinal !== bet.selecao;
    if (mercadoMudou || selecaoMudou) {
      await tx.auditEvent.create({
        data: {
          actor: "system",
          action: "bet.market_correct",
          resource: "bet",
          resourceId: bet.id,
          details: {
            antes: { mercado: bet.mercado, selecao: bet.selecao },
            depois: { mercado: mercadoFinal, selecao: selecaoFinal },
            motivo: `canonização Pinnacle na identidade ${via}`,
          },
        },
      });
    }

    const before = { evento: freshBet.evento, esporte: freshBet.esporte, pais: freshBet.pais,
      competicao: freshBet.competicao, data: freshBet.data.toISOString(), kickoffInferido: freshBet.kickoffInferido };
    const after = {
      evento: eventoFinal, esporte: esporteCanonico, pais, competicao,
      data: kickoffValido ? kickoff.toISOString() : freshBet.data.toISOString(),
      kickoffInferido: kickoffValido ? false : freshBet.kickoffInferido,
    };
    if (!respeitaManual && identityDecisionIsNew({
      stored: freshSharp, provider: "bridgeodds", providerMatchId: String(match.match_id), before, after,
    })) {
      await tx.auditEvent.create({
        data: {
          actor: "system",
          action: via === "LLM" ? "identidade_llm" : "identidade_auto",
          resource: "bet",
          resourceId: bet.id,
          details: {
            via,
            provider: "bridgeodds",
            antes: before,
            depois: after,
            confidence,
            ...(via === "LLM"
              ? { confiancaDoJuiz: params.judgeConfidence ?? null }
              : {}),
            match: `${match.home} vs ${match.away}`,
            providerMatchId: String(match.match_id),
          },
        },
      });
    }
    return { respeitaManual, eventoFinal, selecaoFinal, mercadoMudou, selecaoMudou };
  });
  advanceEnrichTerms({ ...(respeitaManual ? {} : { evento: eventoFinal, esporte: esporteCanonico, pais, competicao }),
    mercado: mercadoFinal, selecao: selecaoFinal, ...(!respeitaManual && kickoffValido ? { data: kickoff } : {}) });
  await recordIdentityKickoff({ betId: bet.id, betKickoff, kickoffInferido: bet.kickoffInferido, matchDate,
    gameStart: params.gameStart });
  if (kickoffValido) {
    bet.data = kickoff;
    bet.kickoffInferido = false;
  }
  if (mercadoMudou) bet.mercado = mercadoFinal;
  if (selecaoMudou) bet.selecao = selecaoFinal;

  // Aqui só o casamento automático ensina; o juiz de IA decide só esta aposta.
  // O Vincular ensina pelo seu próprio serviço.
  if (via === "AUTO" && !respeitaManual) {
    await learnTipsterTeamNames({
      betId: bet.id,
      // O `match_id` da BridgeOdds é o id do evento na Pinnacle17.
      pinnacleEventId: String(match.match_id),
      tipster: { home: localHome, away: localAway },
      pinnacle: { home: match.home, away: match.away },
      kickoff: params.gameStart ?? matchDate,
    });
  }

  return {
    esporteCanonico,
    competicao,
    pais,
    mercado: bet.mercado,
    selecao: bet.selecao,
    data: bet.data,
    kickoffInferido: bet.kickoffInferido,
    kickoffValido,
    kickoff,
  };
}

/**
 * Horário atual do jogo casado pela Bridge, na Pinnacle17 pelo mesmo id: a
 * Bridge guarda o da primeira listagem e não acompanha remarcação. É consulta
 * de rede, feita antes da gravação da identidade. Null sem a Pinnacle17, sem o
 * jogo ou com falha dela.
 */
export async function bridgeMatchGameStart(
  /** `sport` no nome da Bridge ou no da aposta. */
  match: Pick<BridgeMatch, "match_id" | "match_date" | "sport">,
  betKickoff: Date,
): Promise<Date | null> {
  const sportId = pinnacle17SportId(pinnacleEsporteFromBridgeSport(match.sport));
  if (sportId === null) return null;
  try {
    const event = await findPinnacle17EventById({
      sportId, eventId: String(match.match_id), around: [new Date(match.match_date), betKickoff],
    });
    const start = event ? new Date(event.startTime) : null;
    return start && Number.isFinite(start.getTime()) ? start : null;
  } catch (err) {
    log.warn({ err, matchId: match.match_id }, "horário do jogo na Pinnacle17 indisponível — segue sem ele");
    return null;
  }
}

const KICKOFF_DIVERGENCE_MS = 3 * 3_600_000;

/**
 * De onde veio o horário da identidade pela Bridge, e se ele destoa em mais de
 * 3 h: a Pinnacle17 que remarcou o jogo, ou o horário da aposta mantido contra
 * o `match_date` da Bridge sem a Pinnacle17 para desempatar.
 */
async function recordIdentityKickoff(params: {
  betId: string;
  betKickoff: Date;
  kickoffInferido: boolean;
  matchDate: Date;
  gameStart: Date | null;
}): Promise<void> {
  const source = params.gameStart ? "pinnacle17" : params.kickoffInferido ? "bridge" : "bet";
  const other = params.gameStart ?? params.matchDate;
  const diverged = source !== "bridge" && Math.abs(other.getTime() - params.betKickoff.getTime()) > KICKOFF_DIVERGENCE_MS;
  if (diverged) {
    log.info({ betId: params.betId, source, horarioDaAposta: params.betKickoff.toISOString(),
      outroHorario: other.toISOString() }, source === "pinnacle17"
      ? "identidade pela Bridge: a Pinnacle17 moveu o horário do jogo em mais de 3 h"
      : "identidade pela Bridge: horário da aposta mantido, a mais de 3 h do da Bridge e sem a Pinnacle17");
  }
  await recordOperationalMetric({ kind: "action", name: "sharp.identity.kickoff", outcome: "success",
    labels: { source, diverged: diverged ? "yes" : "no" } });
}
