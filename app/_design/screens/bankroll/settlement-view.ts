import { statusDeTela } from "@/src/domain/status-de-aposta";
import { splitEvento } from "../../adapters/_evento";
import { formatSpTime, spDayKey } from "@/src/domain/dates";
import { persistedLiveScoreAtTipText } from "@/src/domain/live-score-at-tip";
import type { ManualSettlementView } from "@/src/domain/manual-settlement";
import type { LocalOverride } from "./settle";

/** A aposta como a tela a mostra, refeita a partir da versão que o servidor confirmou. */
export function settlementOverride(current: ManualSettlementView) {
  return {
    ...splitEvento(current.event), market: current.market, line: current.selection,
    esporte: current.sport, region: current.country, league: current.competition || null,
    day: spDayKey(new Date(current.date)), time: current.kickoffInferred ? "—" : formatSpTime(new Date(current.date)),
    resultDay: current.settledAt ? spDayKey(new Date(current.settledAt)) : null,
    resultTime: current.settledAt ? formatSpTime(new Date(current.settledAt)) : null,
    kickoffInferido: current.kickoffInferred, sportPending: current.sportState !== "CONFIRMED",
    liveScoreAtTip: persistedLiveScoreAtTipText(current),
    odds: current.odds, stake: current.stake,
    status: statusDeTela(current.status), profit: current.status === "PENDING" ? null : current.profit,
    settlementView: current,
  };
}

export type SettlementOverride = ReturnType<typeof settlementOverride> | (LocalOverride & { settlementView?: undefined });

type OverridableBet = { settlementView?: ManualSettlementView | null; d?: object };

/** Uma versão do servidor igual ou mais nova que a do override vence o otimismo local. */
export function applySettlementOverride<B extends OverridableBet>(bet: B, override: SettlementOverride | undefined) {
  if (!override) return bet;
  if (override.settlementView && bet.settlementView != null && bet.settlementView.version >= override.settlementView.version) return bet;
  return { ...bet, ...override, d: { ...bet.d, ...(override.settlementView ? { casa: override.settlementView.bookmaker } : {}) } };
}
