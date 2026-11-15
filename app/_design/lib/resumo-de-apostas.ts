import { sumMoneyBy } from "@/src/domain/money";
import { STATUS_DE_TELA_FINANCEIROS_SET } from "@/src/domain/status-de-aposta";
import { baseAlcancavel, type SituacaoDeCobertura } from "@/src/domain/analyzer/cobertura";

/**
 * Resumo de um conjunto arbitrário de apostas: a mesma conta, um lugar só, para
 * que a tira de KPI e a lista abaixo dela não possam contar bases diferentes.
 * Dinheiro soma por `sumMoneyBy` (BigInt-cents); médias de percentual são média
 * simples, como no servidor.
 */

const FINANCEIROS: ReadonlySet<string> = STATUS_DE_TELA_FINANCEIROS_SET;

type ApostaResumivel = {
  status: string;
  stake?: number | null;
  profit?: number | null;
  clv?: number | null;
  /** `situacaoDoClv` da aposta, calculada no servidor, onde o motivo existe. */
  clvSituacao?: SituacaoDeCobertura;
};

/**
 * A tira de KPI pode contar o recorte, ou tem que ficar na banca? Pura e
 * exportada porque o caso que mais importa (histórico truncado) só aparece na
 * tela com uma banca de 300+ apostas.
 */
export function decidirBaseDaTira({ filtroAtivo, historyTotal, carregadas }: {
  filtroAtivo: boolean;
  historyTotal: number | null | undefined;
  carregadas: number;
}): { base: "banca" | "recorte"; motivo: string } {
  if (!filtroAtivo) return { base: "banca", motivo: "sem filtro" };
  // O servidor manda no máximo 300 apostas. Somar a página como se fosse a
  // banca trocaria um número certo por um plausível.
  const completo = !historyTotal || historyTotal <= carregadas;
  return completo
    ? { base: "recorte", motivo: "histórico completo em mão" }
    : { base: "banca", motivo: "histórico truncado" };
}

/** Aposta liquidada é a que tem resultado: pendente não entra em lucro nem ROI. */
function liquidada<B extends ApostaResumivel>(b: B): b is B & { profit: number } {
  return FINANCEIROS.has(b.status) && b.profit != null && Number.isFinite(b.profit);
}

/**
 * Sem a situação do servidor (aposta criada na tela, mock), só o status diz
 * algo: pendente ainda não fechou; o resto conta como falta sem motivo.
 */
function situacaoDoClvNaTela(b: ApostaResumivel): SituacaoDeCobertura {
  if (b.clvSituacao) return b.clvSituacao;
  if (comClvNumerico(b)) return "tem";
  return b.status === "pending" ? "cedo" : "sem_explicacao";
}

function comClvNumerico<B extends ApostaResumivel>(b: B): b is B & { clv: number } {
  return b.clv != null && Number.isFinite(b.clv);
}

/** Resumo com as mesmas chaves que a tira de KPI e as Estatísticas usam. */
export function resumirApostas<B extends ApostaResumivel>(bets: readonly B[] | null | undefined) {
  const lista: readonly B[] = Array.isArray(bets) ? bets : [];
  const liquidadas = lista.filter(liquidada);
  const pendentes = lista.filter((b) => b.status === "pending");

  const turnover = sumMoneyBy(lista, (b) => b.stake ?? 0);
  const stakeLiquidada = sumMoneyBy(liquidadas, (b) => b.stake ?? 0);
  const lucro = sumMoneyBy(liquidadas, (b) => b.profit);

  // Ganhas e perdidas separadas: +7u de 12/−5 não é a mesma operação que +7u
  // de 8/−1, e o líquido esconde essa diferença.
  const ganhas = sumMoneyBy(liquidadas.filter((b) => b.profit > 0), (b) => b.profit);
  const perdidas = sumMoneyBy(liquidadas.filter((b) => b.profit < 0), (b) => b.profit);

  const comClv = lista.filter(comClvNumerico);
  // A cobertura divide pela base ALCANÇÁVEL: pendente e entrada ao vivo não
  // têm CLV a medir, e contá-las achataria a cobertura.
  const coberturaClv = baseAlcancavel(lista, situacaoDoClvNaTela);

  return {
    total: lista.length,
    liquidadas: liquidadas.length,
    pendentes: pendentes.length,
    turnover,
    stakeLiquidada,
    stakePendente: sumMoneyBy(pendentes, (b) => b.stake ?? 0),
    lucro,
    ganhas,
    perdidas,
    // Sem stake liquidada não existe ROI: "0%" afirmaria um desempenho que
    // ninguém mediu.
    roi: stakeLiquidada > 0 ? (lucro / stakeLiquidada) * 100 : null,
    clvMean: comClv.length ? comClv.reduce((s, b) => s + b.clv, 0) / comClv.length : null,
    clvShare: coberturaClv.pct == null ? null : Math.round(coberturaClv.pct),
    comClv,
    listaLiquidadas: liquidadas,
  };
}
