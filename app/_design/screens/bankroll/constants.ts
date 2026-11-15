const TOTAL_LINES = ['2.5', '3', '3.25', '3.5', '3.75', '4', '4.25', '4.5', '4.75', '5'];

/**
 * Mercados do "Adicionar aposta" e as seleções sugeridas de cada um, na
 * escrita que a liquidação pelo placar entende. A seleção é texto livre: a
 * sugestão só adianta a digitação.
 */
export const MANUAL_BET_MARKETS: Readonly<Record<string, readonly string[]>> = {
  Total: TOTAL_LINES.flatMap((line) => [`Over ${line}`, `Under ${line}`]),
  Handicap: ['Casa -0.5', 'Fora +0.5'],
  '1X2': ['Casa', 'Empate', 'Fora'],
  'Ambas marcam': ['Sim', 'Não'],
};

export const MV_LABEL: Record<string, string> = { steam: 'Steam', drift: 'Drift', estavel: 'Estável' };

export type HistorySortKey = 'odds' | 'movimento' | 'clv' | 'stake' | 'profit';

export const HISTORY_GRID_COLUMNS = 'minmax(0, 1fr) 84px 108px 80px 66px 96px 32px';

/**
 * Colunas do histórico: [rótulo, alinhamento, chave de ordenação]. Sem chave,
 * a coluna não ordena; "Evento e mercado" fica de fora porque a ordem natural
 * da lista é o agrupamento por mês/dia.
 */
export const HISTORY_COLS: ReadonlyArray<readonly [string, 'left' | 'right' | 'center', HistorySortKey?]> = [
  ['Evento e mercado', 'left'], ['Entrada', 'right', 'odds'], ['Abre → fecha', 'right', 'movimento'],
  ['CLV', 'right', 'clv'], ['Unid.', 'right', 'stake'], ['Lucro', 'right', 'profit'], ['', 'center'],
];
/** "Removidas" não é recorte das apostas da banca: lista as que saíram dela, com o "Restaurar". */
export const HISTORY_TABS = [['todas', 'Todas'], ['pendentes', 'Pendentes'], ['ganhas', 'Positivas'], ['perdidas', 'Negativas'], ['removidas', 'Removidas']] as const;
