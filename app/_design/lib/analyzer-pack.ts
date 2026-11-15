import type { BetRowData } from "@/src/domain/bet-read-model";

/** Shape colunar compacto: evita repetir ~25 chaves por aposta no payload RSC. */
export type AnalyzerPackedBet = [
  day: string, data: string, evento: string, competicao: string, pais: string,
  esporte: string, mercado: string, casaDeAposta: string, odds: number, stake: number,
  status: string, lucro: number, registradoEm: string, closingOdd: number | null,
  openingMaxBet: number | null, openingOdd: number | null,
  openingRawOdd: number | null, closingRawOdd: number | null, clv: number | null,
  clvReliable: boolean | null, closingFetchedAt: string | null,
  /** Quando liquidou. Não é eixo de cálculo: recorte e baldes usam o dia do jogo (`day`). */
  settledAt: string | null,
  /**
   * Só a GAVETA lê estas duas — o cálculo segue cego a elas
   * (`tests/painel/tested-analyzer.test.ts`). Sem `id` a lista de apostas não
   * tem chave estável nem link para a ficha; sem `selecao`, duas apostas no
   * mesmo jogo aparecem idênticas.
   */
  id: string, selecao: string,
  /**
   * Os dois motivos de ausência de odds. Ao contrário de `id`/`selecao`, estes
   * o CÁLCULO lê: são eles que separam "não tem CLV porque foi ao vivo" (fora do
   * denominador) de "não tem e ninguém sabe por quê" (dentro). Sem eles a
   * cobertura volta a dividir pelo conjunto inteiro — ver `analyzer/cobertura.ts`.
   */
  noOddsReason: string | null, closingNoOddsReason: string | null,
  openingMaxBetCurrency: string | null,
  closingMaxBet: number | null, closingMaxBetCurrency: string | null,
  /** Motivo da abertura ausente: decide a base da cobertura de abertura. */
  openingNoOddsReason: string | null,
  /**
   * A aba Timing mede a antecedência a partir do post e deixa de fora o kickoff
   * provisório; sem estas duas o cliente contaria do registro.
   */
  sourcePostedAt: string | null, kickoffInferido: boolean,
  /** A banca da aposta, só na carteira: a dimensão Canal. Na banca vai vazio. */
  bankrollName: string,
  /** O valor da unidade da aposta, só na carteira (o simulador de stake volta às unidades). */
  valorUnidade: number | null,
  closingUpdatedAt: string | null,
  stakeUnits: number | null, profitUnits: number | null,
];

export function packAnalyzerBet(b: BetRowData, day: string): AnalyzerPackedBet {
  return [
    day, b.data.toISOString(), b.evento, b.competicao, b.pais, b.esporte, b.mercado,
    b.casaDeAposta, b.odds, b.stake, b.status, b.lucro, b.registradoEm.toISOString(),
    b.closingOdd, b.openingMaxBet, b.openingOdd, b.openingRawOdd, b.closingRawOdd, b.clv,
    b.clvReliable, b.closingFetchedAt?.toISOString() ?? null,
    b.settledAt?.toISOString() ?? null,
    b.id, b.selecao,
    b.noOddsReason, b.closingNoOddsReason,
    b.openingMaxBetCurrency ?? null,
    b.closingMaxBet, b.closingMaxBetCurrency ?? null,
    b.openingNoOddsReason ?? null,
    b.sourcePostedAt?.toISOString() ?? null, b.kickoffInferido === true,
    b.bankrollName ?? "",
    b.valorUnidade ?? null,
    b.closingUpdatedAt?.toISOString() ?? null,
    b.stakeUnits ?? null, b.profitUnits ?? null,
  ];
}

export function unpackAnalyzerBet(p: AnalyzerPackedBet): BetRowData & { day: string } {
  return {
    day: p[0], id: p[22], data: new Date(p[1]), evento: p[2], competicao: p[3], pais: p[4],
    esporte: p[5], mercado: p[6], selecao: p[23], casaDeAposta: p[7], tipster: "",
    odds: p[8], stake: p[9], status: p[10], lucro: p[11], registradoEm: new Date(p[12]),
    closingOdd: p[13], openingMaxBet: p[14], openingOdd: p[15], openingRawOdd: p[16],
    closingRawOdd: p[17], clv: p[18], clvReliable: p[19],
    closingFetchedAt: p[20] ? new Date(p[20]) : null, closingMaxBet: p[27],
    settledAt: p[21] ? new Date(p[21]) : null,
    identityStatus: null, noOddsReason: p[24], closingNoOddsReason: p[25],
    openingMaxBetCurrency: p[26],
    closingMaxBetCurrency: p[28],
    openingNoOddsReason: p[29],
    sourcePostedAt: p[30] ? new Date(p[30]) : null, kickoffInferido: p[31] === true,
    ...(p[32] ? { bankrollName: p[32] } : {}),
    ...(p[33] != null ? { valorUnidade: p[33] } : {}),
    closingUpdatedAt: p[34] ? new Date(p[34]) : null,
    ...(p[35] != null ? { stakeUnits: p[35] } : {}),
    ...(p[36] != null ? { profitUnits: p[36] } : {}),
    source: "", sourceExternalId: null, contaTitular: null,
  };
}

export function unpackAnalyzerBets(rows: AnalyzerPackedBet[]): Array<BetRowData & { day: string }> {
  return rows.map(unpackAnalyzerBet);
}
