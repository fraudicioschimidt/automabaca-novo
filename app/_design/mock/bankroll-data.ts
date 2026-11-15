// Detalhe da banca "Big Data" (`?mock=1`), na forma do adaptador.
import type { getBankrollData } from "../adapters/bankroll";
import { BETS, CHART, METRICS } from "./bet";
import { TIP } from "./dashboard";

export const BANKROLL_MOCK_DATA: NonNullable<Awaited<ReturnType<typeof getBankrollData>>> = {
  liveVersion: null,
  BETS,
  historyTotal: BETS.length,
  removed: {
    total: 3,
    bets: [
      { id: 'r1', home: 'Grêmio', away: 'Internacional', market: 'Total de gols', line: 'Under 2.5', odds: 1.93, stake: 1, day: '2026-06-13',
        removal: { at: '13/06 21:40', origin: 'reacao', restorable: true, previous: { status: 'won', profit: 0.93 } } },
      { id: 'r2', home: 'Bahia', away: 'Fortaleza', market: 'Handicap asiático', line: 'Bahia -0.5', odds: 2.05, stake: 0.5, day: '2026-06-14',
        removal: { at: '14/06 10:05', origin: 'painel', restorable: true, previous: { status: 'pending', profit: null } } },
      { id: 'r3', home: 'Santos', away: 'Vasco', market: 'Total de gols', line: 'Under 3', odds: 1.88, stake: 1, day: '2026-06-02',
        removal: { at: '02/06 18:12', origin: 'painel', restorable: false, previous: null } },
    ],
  },
  METRICS,
  CHART,
  todayKey: '2026-06-14',
  bk: { name: 'Big Data', sharpMode: 'CLV_ONLY', slug: 'main', logoUrl: null },
  tips: TIP.tipsters.map((tipster) => ({
    id: tipster.id,
    name: tipster.name,
  })),
};
