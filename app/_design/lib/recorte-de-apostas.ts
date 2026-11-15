import type { PerdaDeCobertura } from "@/src/domain/analyzer/cobertura";
import { fmtPct, UNITS_FORMAT, type MoneyFormat } from "@/src/domain/formato-de-resultado";
import { contagem } from "./plural";

/**
 * O que a gaveta do Analyzer abre. Puro, sem React: as abas importam daqui sem
 * arrastar o componente da gaveta, que é carregado sob demanda.
 */

type Tom = "pos" | "neg" | "neutro";
type ItemDoResumo = { k: string; v: string; tom?: Tom };
type Recorte<A> = { titulo: string; contexto: string; apostas: readonly A[]; resumo: ItemDoResumo[] };
/** `money`: como o dinheiro do resumo sai (unidades na banca, reais na carteira). */
type Rotulos = { rotulo?: string; contexto?: string; money?: MoneyFormat };

type LinhaAgregada<A> = {
  membros?: readonly A[] | null;
  l?: string | null;
  k?: string | null;
  label?: string | null;
  n?: number | null;
  stake?: number | null;
  lucro?: number | null;
  roi?: number | null;
  clv?: number | null;
};

type CelulaDoHeatmap<A> = {
  membros?: readonly A[] | null;
  liquidadas?: readonly unknown[] | null;
  stake?: number | null;
  profit?: number | null;
};

function tom(v: number | null | undefined): Tom {
  if (v == null) return "neutro";
  return v > 0 ? "pos" : v < 0 ? "neg" : "neutro";
}

/**
 * Recorte de uma linha de tabela. `linha.membros` é o array que `agregaGrupo`
 * agregou, não uma cópia nem um filtro refeito. O `resumo` repete os números da
 * linha de propósito: é a prova visível de que gaveta e linha contam a mesma base.
 */
export function recorteDaLinha<A>(linha: LinhaAgregada<A>, { rotulo, contexto, money = UNITS_FORMAT }: Rotulos = {}): Recorte<A> {
  const membros = linha.membros ?? [];
  const nome = rotulo ?? linha.l ?? linha.k ?? linha.label ?? "Recorte";
  return {
    titulo: nome,
    contexto: contexto ?? contagem(membros.length, "aposta"),
    apostas: membros,
    resumo: [
      { k: "Apostas", v: String(linha.n ?? membros.length) },
      { k: "Stake", v: money.amount(linha.stake) },
      { k: "Lucro", v: money.signed(linha.lucro), tom: tom(linha.lucro) },
      { k: "ROI", v: linha.roi == null ? "—" : fmtPct(linha.roi), tom: tom(linha.roi) },
      { k: "CLV médio", v: linha.clv == null ? "—" : fmtPct(linha.clv), tom: tom(linha.clv) },
    ],
  };
}

/**
 * Recorte da célula do heatmap, o único lugar do Analyzer onde contagem e soma
 * têm bases diferentes de propósito: `n` conta todas (inclusive pendentes) e o
 * ROI só as liquidadas. O resumo declara as duas.
 */
export function recorteDaCelula<A>(
  celula: CelulaDoHeatmap<A> | null | undefined,
  { rotulo, contexto, money = UNITS_FORMAT }: Rotulos = {},
): Recorte<A> {
  const membros = celula?.membros ?? [];
  const liquidadas = celula?.liquidadas ?? [];
  const stake = celula?.stake ?? 0;
  const roi = stake > 0 ? ((celula?.profit ?? 0) / stake) * 100 : null;
  return {
    titulo: rotulo ?? "Janela",
    contexto: contexto ?? contagem(membros.length, "aposta"),
    apostas: membros,
    resumo: [
      { k: "Apostas", v: String(membros.length) },
      { k: "Liquidadas", v: String(liquidadas.length) },
      { k: "Stake", v: money.amount(stake) },
      { k: "Lucro", v: money.signed(celula?.profit ?? 0), tom: tom(celula?.profit ?? 0) },
      { k: "ROI", v: roi == null ? "—" : fmtPct(roi), tom: tom(roi) },
    ],
  };
}

/**
 * Recorte de uma lacuna de cobertura: as apostas que a métrica não alcançou.
 * Não há ROI nem CLV a repetir (é o que falta); a gaveta confirma quantas
 * apostas e quanto stake ficou sem medição, e o mercado que domina o motivo.
 */
export function recorteDePerdaDeCobertura<A>(
  perda: PerdaDeCobertura<A> | null | undefined,
  { nomeDaMetrica = "CLV", money = UNITS_FORMAT }: { nomeDaMetrica?: string; money?: MoneyFormat } = {},
): Recorte<A> {
  const membros = perda?.membros ?? [];
  return {
    titulo: perda?.rotulo ?? "Sem cobertura",
    contexto: `${contagem(membros.length, "aposta")} sem ${nomeDaMetrica}`,
    apostas: membros,
    resumo: [
      { k: "Apostas", v: String(perda?.n ?? membros.length) },
      { k: "Stake exposto", v: money.amount(perda?.stake ?? 0) },
      {
        k: "Mercado",
        v: perda?.mercadoDominante
          ? `${perda.mercadoDominante} (${perda.nDoMercado})`
          : "—",
      },
    ],
  };
}
