// Dados de demonstração da tela Config, na forma do adaptador.
import type { getConfigData } from "../adapters/config";

type ConfigData = Awaited<ReturnType<typeof getConfigData>>;
type TeamCard = ConfigData["teamCards"]["cards"][number];

let cardSeq = 0;
function teamCard(row: Omit<TeamCard, "id" | "tipsterNames"> & { tipsters?: Array<[string, boolean]> }): TeamCard {
  cardSeq += 1;
  const { tipsters = [], ...card } = row;
  return {
    ...card,
    id: `card-${cardSeq}`,
    tipsterNames: tipsters.map(([name, confirmed], i) => ({ id: `tipster-${cardSeq}-${i}`, name, confirmed })),
  };
}

export const CFG: ConfigData = {
  catalogPairing: {
    lastRound: '12:37', stoppedBy: null,
    linkedToday: 184, teamCards: 2310, inProgress: false,
  },
  security: {
    username: 'Fabricio',
    sessionsTotal: 2,
    sessions: [
      { id: 'session-current', deviceName: 'Chrome em Windows', createdAt: '12/07 20:00', lastSeenAt: '12/07 22:10', current: true },
      { id: 'session-phone', deviceName: 'Safari em iOS', createdAt: '10/07 09:30', lastSeenAt: '12/07 18:42', current: false },
    ],
  },
  bancas: [
    {
      id: 'b1', slug: 'main', name: 'Big Data', sharpMode: 'CLV_ONLY', capturePolicy: 'AUTO',
      stakePolicy: 'MESSAGE', defaultStakeUnits: null, unit: 'R$100/u', unitValue: 100,
      channel: '-1004262961788', channelRaw: '-1004262961788', logoUrl: null, betCount: 13,
      channelSports: [], capturePaused: false, pausedSince: null, confirmedSports: [{ sport: 'Basketball', bets: 11 }, { sport: 'Soccer', bets: 2 }],
    },
    {
      id: 'b2', slug: 'cestinha', name: 'Cestinha', sharpMode: 'CLV_ONLY', capturePolicy: 'AUTO',
      stakePolicy: 'MESSAGE', defaultStakeUnits: null, unit: 'R$50/u', unitValue: 50,
      channel: '-1004262961799', channelRaw: '-1004262961799', logoUrl: null, betCount: 4,
      channelSports: ['Basketball'], capturePaused: true, pausedSince: '20/07 14:05', confirmedSports: [{ sport: 'Basketball', bets: 4 }],
    },
  ],

  // taxonomia canônica de mercados (estilo Pinnacle) + aliases aprendidos
  markets: [
    { canon: '1st Half Asian Corners', aliases: ['1st Half Asian Corners', '1º Tempo - Escanteios Asiáticos', 'Primeiro Tempo Escanteios Asiáticos'] },
    { canon: '1st Half Moneyline', aliases: ['1H - Draw No Bet', '1º Tempo - Empate Devolve Aposta', '1º Tempo - Para Ganhar', 'First Half - Draw No Bet'] },
    { canon: '1st Half Total', aliases: ['1H Totals', '1º Tempo - Totais', '1º Tempo O/U', '1º Tempo Over/Under', 'First Half Totals'] },
    { canon: 'Anytime Goalscorer', aliases: ['Anytime Goalscorer', 'Jogador Marcar a Qualquer Momento', 'Marcar a Qualquer Momento', 'To Score Anytime'] },
    { canon: 'Asian Handicap', aliases: ['AH', 'Asian Handicap', 'Handicap', 'Handicap (incl. prorrogação)', 'Handicap Asiático', 'Handicap Europeu', 'Handicap de Pontos'] },
    { canon: 'Asian Handicap Cards', aliases: ['Asian Handicap Cards', 'Asian Handicap Cards FT', 'Handicap Asiático Cartões', 'Handicap Asiático de Cartões', 'Handicap Cartões Asiático'] },
    { canon: 'Asian Handicap Corners', aliases: ['Asian Handicap Corners', 'Asian Handicap Corners FT', 'Handicap Asiático Escanteios', 'Handicap Escanteios Asiático'] },
    { canon: 'Asian Total Cards', aliases: ['Asian Total Cards', 'Total de Cartões Asiático'] },
    { canon: 'Asian Total Corners', aliases: ['Asian Total Corners', 'Asian Total Corners FT', 'Total Escanteios Asiático', 'Total de Escanteios Asiáticos'] },
    { canon: 'Both Teams to Score', aliases: ['Ambas Marcam', 'Ambas as equipes marcam', 'BTTS', 'Both Teams to Score'] },
    { canon: 'Cards', aliases: ['Cards', 'Cartões'] },
    { canon: 'Moneyline', aliases: ['1X2', 'Draw No Bet', 'Empate Anula', 'Match Odds', 'Resultado Final', 'Vencedor'] },
    { canon: 'Spread', aliases: ['Handicap Europeu', 'Linha', 'Point Spread', 'Spread'] },
    { canon: 'Total', aliases: ['Abaixo de', 'Acima de', 'Gols Acima/Abaixo', 'Mais de', 'Mais/Menos', 'Mais/Menos de Gols', 'Menos de', 'Over', 'Over/Under', 'Under'] },
    { canon: 'Total Cards', aliases: ['Cards Over/Under', 'Cartões Acima/Abaixo', 'Cartões Over/Under', 'Cartões Total', 'Mais/Menos Cartões', 'Over/Under Cartões', 'Total Cards', 'Total Cartões', 'Total de Cartões'] },
    { canon: 'Total Points', aliases: ['Evento Completo - Total de Pontos', 'Tempo Regular - Total de Pontos', 'Totais de Jogo', 'Total (incl. prorrogação)', 'Total Points', 'Total de Pontos'] },
  ],
  marketCount: 22,

  // fichas de time montadas pelo pareamento dos catálogos
  teamCards: {
    cards: [
      teamCard({ sport: 'Soccer', name: 'Fenix', country: 'Uruguay', league: 'Segunda Division', category: 'principal', flashscoreTeamId: '8hWKNqzL', flashscoreName: 'Fenix',
        pinnacleNames: [{ name: 'Fenix', games: 12 }], tipsters: [['Atletico Fenix Montevideo', true], ['Fenix MVD', false]] }),
      teamCard({ sport: 'Soccer', name: 'Boise', country: 'USA', league: 'USL League One', category: 'principal', flashscoreTeamId: 'Q3xk1LpA', flashscoreName: 'AC Boise',
        pinnacleNames: [{ name: 'Boise', games: 7 }, { name: 'AC Boise', games: 2 }], tipsters: [['ac boise', true]] }),
      teamCard({ sport: 'Soccer', name: 'Birmingham Legion II', country: 'USA', league: 'USL League 2', category: 'reserva', flashscoreTeamId: 'Zt8mW2yc', flashscoreName: 'Birmingham Legion 2',
        pinnacleNames: [{ name: 'Birmingham Legion II', games: 4 }], tipsters: [['birmigham legion', false]] }),
      teamCard({ sport: 'Soccer', name: 'Northern Tigers (W)', country: 'Australia', league: 'NPL New South Wales Women', category: 'feminino', flashscoreTeamId: 'b7Hc0eRs', flashscoreName: 'Northern Tigers W',
        pinnacleNames: [{ name: 'Northern Tigers (W)', games: 9 }] }),
      teamCard({ sport: 'Soccer', name: 'Riga FC', country: 'Latvia', league: 'Virsliga', category: 'principal', flashscoreTeamId: 'nRk4Ew1T', flashscoreName: 'Riga FC',
        pinnacleNames: [{ name: 'Riga FC', games: 15 }, { name: 'FK Riga', games: 1 }], tipsters: [['riga', true]] }),
      teamCard({ sport: 'Basketball', name: 'Flamengo', country: 'Brazil', league: 'NBB', category: 'principal', flashscoreTeamId: 'hG2dPq9s', flashscoreName: 'Flamengo',
        pinnacleNames: [{ name: 'Flamengo', games: 6 }], tipsters: [['fla basquete', false]] }),
    ],
    total: 6,
    nextOffset: null,
    sports: [{ sport: 'Basketball', count: 1 }, { sport: 'Soccer', count: 5 }],
  },
};
