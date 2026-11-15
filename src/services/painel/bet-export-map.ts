import "server-only";
import { spDayKey, formatSpTime } from "@/src/domain/dates";
import {
  betExportIdentityLabel,
  betExportOriginLabel,
  type BetExportInput,
} from "@/src/domain/bet-export";
import { splitEventoTeams } from "@/src/domain/text";
import { persistedLiveScoreAtTipText } from "@/src/domain/live-score-at-tip";
import { fechamentoConfirmado, missingClvReason } from "@/src/domain/no-odds-reason";
import { percentualContraFair } from "@/src/domain/odds";
import type { BetRowData } from "@/src/domain/bet-read-model";

/**
 * BetRowData (borda do painel) → linha canônica de export.
 * CLV/closing só quando o fechamento está congelado (fetchedAt) e confiável —
 * mesma regra da ficha (`toBet`), para o CSV não mentir “CLV final” pré-kickoff.
 */
export function betRowToExportInput(r: BetRowData): BetExportInput {
  const teams = splitEventoTeams(r.evento);
  const home = teams?.home ?? r.evento;
  const away = teams?.away ?? "";
  // Mesma regra da ficha: `fetchedAt` marca "já tentou congelar", não "tem
  // fechamento". Ver `fechamentoConfirmado` (`domain/no-odds-reason`).
  const fechamentoExibivel = fechamentoConfirmado(r);
  const closingFinal = r.closingFetchedAt != null && r.clvReliable === true;
  const resolvido = r.status !== "PENDING";

  const stake = r.stakeUnits ?? r.stake;
  const profit = resolvido ? (r.profitUnits ?? r.lucro) : null;
  return {
    id: r.id, bankrollSlug: r.bkSlug,
    unitValue: r.valorUnidade,
    kickoffIso: r.data.toISOString(), kickoffInferred: r.kickoffInferido === true,
    registeredIso: r.registradoEm.toISOString(), postedIso: r.sourcePostedAt?.toISOString(),
    settledIso: r.settledAt?.toISOString(), sourceExternalId: r.sourceExternalId ?? undefined,
    closingFrozenIso: r.closingFetchedAt?.toISOString(), closingUpdatedIso: r.closingUpdatedAt?.toISOString(), clvReliable: closingFinal,
    openingRaw: r.openingRawOdd, closingRaw: fechamentoExibivel ? r.closingRawOdd : null,
    openingEvidence: r.openingEvidence, closingEvidence: fechamentoExibivel ? r.closingEvidence : null,
    openingLimit: r.openingMaxBet, openingCurrency: r.openingMaxBetCurrency,
    closingLimit: fechamentoExibivel ? r.closingMaxBet : null,
    closingCurrency: fechamentoExibivel ? r.closingMaxBetCurrency : null,
    day: spDayKey(r.data),
    time: formatSpTime(r.data),
    settledDay: r.settledAt ? spDayKey(r.settledAt) : "",
    settledTime: r.settledAt ? formatSpTime(r.settledAt) : "",
    home,
    away,
    esporte: r.esporte,
    region: r.pais,
    league: r.competicao || "",
    market: r.mercado,
    line: r.selecao,
    scoreAtTip: persistedLiveScoreAtTipText(r) ?? "",
    casa: r.casaDeAposta || "",
    titular: r.contaTitular || "",
    conta: r.contaApelido || r.contaId || "",
    tipster: r.tipster || "",
    origin: betExportOriginLabel(r.source),
    odds: r.odds,
    opening: r.openingOdd,
    closing: fechamentoExibivel ? r.closingOdd : null,
    // Movimento da linha (abertura → fechamento, justas); odd inválida fica vazia.
    movimento: r.openingOdd != null && fechamentoExibivel && r.closingOdd != null
      ? percentualContraFair(r.closingOdd, r.openingOdd)
      : null,
    clv: closingFinal ? r.clv : null,
    stake,
    status: r.status,
    profit,
    identity: betExportIdentityLabel(r.identityStatus),
    noOdds: missingClvReason(r) ?? "",
  };
}
