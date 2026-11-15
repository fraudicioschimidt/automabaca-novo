import {
  lacunasDeCobertura,
  type BaseDaLacuna,
  type LinhaClassificada,
  type LinhaSemOdds,
} from "@/src/domain/lacuna-de-cobertura";
import { noOddsReasonLabel } from "@/src/domain/no-odds-reason";
import { contagem } from "./plural";

/**
 * O cartão "Sem odds", pronto para desenhar.
 *
 * O domínio separa as três bases e ordena; aqui entra só a prosa em PT e a
 * chave de lista. A separação existe porque cada base pede uma decisão
 * diferente: comprar cobertura (fornecedor), consertar o motor (sistema) ou
 * nada (a métrica não se aplica).
 */

export type LinhaNaTela = LinhaClassificada & {
  readonly id: string;
  readonly rotulo: string;
};

export type GrupoNaTela = {
  readonly base: BaseDaLacuna;
  readonly total: number;
  readonly linhas: readonly LinhaNaTela[];
};

export type LacunaNaTela = {
  readonly total: number;
  readonly fornecedor: GrupoNaTela;
  readonly sistema: GrupoNaTela;
  readonly naoSeAplica: GrupoNaTela;
};

export function lacunaNaTela(linhas: readonly LinhaSemOdds[]): LacunaNaTela {
  const { fornecedor, sistema, naoSeAplica, total } = lacunasDeCobertura(linhas);
  const comRotulo = (grupo: typeof fornecedor): GrupoNaTela => ({
    base: grupo.base,
    total: grupo.total,
    linhas: grupo.linhas.map((linha) => ({
      ...linha,
      // O lado entra na chave: o MESMO motivo pode faltar em mais de um lado,
      // e sem ele as linhas colidiam.
      id: `${linha.lado}-${linha.reason}`,
      rotulo: noOddsReasonLabel(linha.reason),
    })),
  });
  return {
    total,
    fornecedor: comRotulo(fornecedor),
    sistema: comRotulo(sistema),
    naoSeAplica: comRotulo(naoSeAplica),
  };
}

/**
 * "em 16 segmentos · maior: Spain · La Liga (4)" — o caminho para o detalhe.
 * Com um segmento só não há "maior": a linha nomeia o segmento e pronto.
 */
export function textoDoSegmento(linha: LinhaNaTela): string {
  if (!linha.topoSegmento) return `em ${contagem(linha.segmentos, "segmento")}`;
  if (linha.segmentos === 1) return linha.topoSegmento;
  return `em ${contagem(linha.segmentos, "segmento")} · maior: ${linha.topoSegmento} (${linha.topoN})`;
}

const O_QUE_A_BASE_PEDE: Record<BaseDaLacuna, string> = {
  fornecedor: "decisão de cobertura",
  sistema: "conserto nosso",
  nao_se_aplica: "a métrica não se aplica",
};

/** Cabeçalho de cada base — o número e o que ele pede. */
export function textoDaBase(grupo: GrupoNaTela): string {
  return `${contagem(grupo.total, "aposta")} — ${O_QUE_A_BASE_PEDE[grupo.base]}`;
}
