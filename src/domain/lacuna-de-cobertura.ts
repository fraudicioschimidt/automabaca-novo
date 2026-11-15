import { noOddsReasonBase, type NoOddsReasonBase } from "@/src/domain/no-odds-reason";

/**
 * Aposta sem odds, separada pelo que a ausência SIGNIFICA.
 *
 * O cartão "Sem odds" do Monitoramento serve para decidir o que consertar. Os
 * lados são `identidade` (`bet_sharp`), `abertura` (`bet_opening`) e
 * `fechamento` (`bet_closing`). A base de cada motivo vem do vocabulário
 * (`noOddsReasonBase`): a do fornecedor decide comprar cobertura, a do sistema
 * é conserto nosso, e a que não se aplica (entrada ao vivo, política da banca)
 * não é decisão de ninguém — misturadas, uma soterra a outra. Agrupar por
 * motivo, e não por país × competição, mantém poucas linhas e dispensa truncar
 * a lista.
 */

export type LinhaSemOdds = {
  readonly lado: string;
  readonly reason: string;
  readonly n: number;
  /** Em quantos pares país×competição distintos o motivo apareceu. */
  readonly segmentos: number;
  readonly topoSegmento: string | null;
  readonly topoN: number;
};

export type BaseDaLacuna = NoOddsReasonBase;

export type LinhaClassificada = LinhaSemOdds & { readonly pct: number };

export type GrupoDeLacuna = {
  readonly base: BaseDaLacuna;
  readonly total: number;
  readonly linhas: readonly LinhaClassificada[];
};

export type LacunasDeCobertura = {
  readonly fornecedor: GrupoDeLacuna;
  readonly sistema: GrupoDeLacuna;
  readonly naoSeAplica: GrupoDeLacuna;
  readonly total: number;
};

function montar(base: BaseDaLacuna, linhas: LinhaSemOdds[]): GrupoDeLacuna {
  const total = linhas.reduce((soma, linha) => soma + linha.n, 0);
  return {
    base,
    total,
    // A fração é do PRÓPRIO grupo: "45% da lacuna do fornecedor" é a frase que
    // decide provider; "45% de tudo que não tem odds" mistura as bases de novo.
    linhas: linhas
      .slice()
      .sort((a, b) => b.n - a.n)
      .map((linha) => ({ ...linha, pct: total > 0 ? (linha.n / total) * 100 : 0 })),
  };
}

export function lacunasDeCobertura(linhas: readonly LinhaSemOdds[]): LacunasDeCobertura {
  const porBase: Record<BaseDaLacuna, LinhaSemOdds[]> = { fornecedor: [], sistema: [], nao_se_aplica: [] };
  for (const linha of linhas) porBase[noOddsReasonBase(linha.reason)].push(linha);
  return {
    fornecedor: montar("fornecedor", porBase.fornecedor),
    sistema: montar("sistema", porBase.sistema),
    naoSeAplica: montar("nao_se_aplica", porBase.nao_se_aplica),
    total: linhas.reduce((soma, linha) => soma + linha.n, 0),
  };
}
