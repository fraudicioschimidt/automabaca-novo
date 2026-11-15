import { sumMoneyBy, kahanSum } from "@/src/domain/money";
import { FINAL_BET_STATUSES_SET } from "@/src/domain/bet-status";
import { hitRateFromCounts } from "@/src/domain/hit-rate";
import type { BetRowData } from "@/src/domain/bet-read-model";

/** Helpers comuns dos cálculos do analyzer (puros, testáveis). */

export const RESOLVIDOS = FINAL_BET_STATUSES_SET;

/**
 * Subconjunto estrutural de BetRowData que os agregadores exigem — permite
 * alimentá-los com selects mais enxutos (ex.: decisão por canal) sem carregar
 * a linha completa.
 */
export type BetAggInput = Pick<
  BetRowData,
  "status" | "stake" | "lucro" | "clv" | "clvReliable" | "closingFetchedAt"
>;

export function resolvidas<T extends Pick<BetRowData, "status">>(bets: T[]): T[] {
  return bets.filter((b) => typeof b.status === "string" && RESOLVIDOS.has(b.status.trim().toUpperCase()));
}

/**
 * CLV utilizável em métrica = só fechamento CONGELADO (`closingFetchedAt`) e
 * confiável. O provisório pré-kickoff (fetchedAt=null, mas clvReliable=true)
 * ainda se move e poluiria médias, t-test e o veredito de canal. O SQL do mesmo
 * corte é `reliableClvSql` (services/sharp/closing-evidence).
 */
export function clvConfiavel(
  b: Pick<BetRowData, "clv" | "clvReliable" | "closingFetchedAt">,
): number | null {
  if (b.closingFetchedAt == null || b.clvReliable !== true) return null;
  if (typeof b.clv !== "number" || !Number.isFinite(b.clv)) return null;
  return b.clv;
}


/** ROI em % sobre a stake; null sem stake (divisão sem base não é 0%). */
export function roiPct(lucro: number, stake: number): number | null {
  return stake > 0 ? (lucro / stake) * 100 : null;
}

export function media(valores: number[]): number | null {
  const finitos = valores.filter(Number.isFinite);
  if (finitos.length === 0) return null;
  return kahanSum(finitos) / finitos.length;
}

export function mediana(valores: number[]): number | null {
  const finitos = valores.filter(Number.isFinite);
  if (finitos.length === 0) return null;
  const ord = [...finitos].sort((a, b) => a - b);
  const meio = Math.floor(ord.length / 2);
  const right = ord[meio];
  if (right === undefined) return null;
  if (ord.length % 2) return right;
  const left = ord[meio - 1];
  return left === undefined ? null : (left + right) / 2;
}

/** Desvio-padrão amostral (n−1); null com menos de 2 valores. */
export function desvioPadraoAmostral(valores: number[]): number | null {
  const finitos = valores.filter(Number.isFinite);
  if (finitos.length < 2) return null;
  const m = media(finitos);
  if (m === null) return null;
  const somaQuad = kahanSum(finitos.map((v) => (v - m) ** 2));
  return Math.sqrt(somaQuad / (finitos.length - 1));
}

// ───────────── Significância do edge (contrato do Analyzer) ─────────────

/** Amostra mínima de CLVs confiáveis para emitir veredito. */
export const AMOSTRA_MINIMA_CLV = 30;

/**
 * Piso de EXIBIÇÃO: abaixo disso o número é anedota, não medição.
 *
 * Conceito diferente do `AMOSTRA_MINIMA_CLV` acima, que é o piso do teste t —
 * um decide se há EDGE, este decide se a tela tem o direito de mostrar um
 * número como se ele significasse algo. Já era o piso de fato desta tela,
 * escrito como literal `>= 5` em quatro lugares (`casas-tab`, `segmentos-tab`);
 * o nome só o torna alcançável pelo comparativo, que passava sem nenhum.
 */
export const AMOSTRA_MINIMA_EXIBICAO = 5;

/**
 * Valor crítico bicaudal 95% da distribuição t com `df` graus de liberdade. A
 * decisão usa teste t: no n mínimo (df 29) o crítico é 2.045, e o 1.96 da
 * normal daria EDGE onde o teste diz INCONCLUSIVO. Expansão de Cornish-Fisher
 * (exata a ~1e-4 para df ≥ 29; tende a 1.96 quando df → ∞).
 */
export function tCritico95(df: number): number {
  const z = 1.959964; // normal 97.5%
  if (!Number.isFinite(df) || df <= 0) return z;
  const z3 = z ** 3;
  const z5 = z ** 5;
  const z7 = z ** 7;
  return (
    z +
    (z3 + z) / (4 * df) +
    (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2) +
    (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3)
  );
}

export type EdgeVeredito = "EDGE" | "SEM_EDGE" | "INCONCLUSIVO" | "AMOSTRA_CURTA";

/** Ordem de exibição em rankings: melhor evidência primeiro. */
export const VEREDITO_RANK: Record<EdgeVeredito, number> = {
  EDGE: 0,
  INCONCLUSIVO: 1,
  AMOSTRA_CURTA: 2,
  SEM_EDGE: 3,
};

/** Chave de exibição na tela de assinatura — o ranking continua em `VEREDITO_RANK`. */
export const VEREDITO_NA_TELA = {
  EDGE: "forte",
  INCONCLUSIVO: "monitorar",
  AMOSTRA_CURTA: "amostra curta",
  SEM_EDGE: "pausar",
} as const satisfies Record<EdgeVeredito, string>;

/** O veredito como o dono o lê: na decisão de Bancas e no aviso 📥. */
export const VEREDITO_ROTULO = {
  EDGE: "Manter",
  INCONCLUSIVO: "Monitorar",
  AMOSTRA_CURTA: "Amostra curta",
  SEM_EDGE: "Pausar",
} as const satisfies Record<EdgeVeredito, string>;

export function vereditoDeChaveNaTela(
  chave: string | null | undefined,
): EdgeVeredito | null {
  if (!chave) return null;
  for (const veredito of Object.keys(VEREDITO_RANK) as EdgeVeredito[]) {
    if (VEREDITO_NA_TELA[veredito] === chave) return veredito;
  }
  return null;
}

/**
 * Teste t de uma amostra sobre o CLV médio (H0: CLV = 0, 95%). É o critério
 * de "amostra mínima para significância": com menos de
 * AMOSTRA_MINIMA_CLV CLVs confiáveis o veredito é sempre AMOSTRA_CURTA.
 */
export function vereditoEdgeFromStats(
  n: number,
  m: number | null,
  sd: number | null,
): { veredito: EdgeVeredito; tStat: number | null } {
  if (!Number.isSafeInteger(n) || n < 2) return { veredito: "AMOSTRA_CURTA", tStat: null };
  if (m === null || !Number.isFinite(m) || sd === null || !Number.isFinite(sd) || sd < 0) {
    return { veredito: n < AMOSTRA_MINIMA_CLV ? "AMOSTRA_CURTA" : "INCONCLUSIVO", tStat: null };
  }
  // A tolerância é relativa à média: mudar a escala não pode mudar o veredito.
  const effectivelyZeroSd = sd === 0 || sd <= 1e-9 * Math.abs(m);
  const tStat = effectivelyZeroSd ? null : (m / sd) * Math.sqrt(n);
  if (n < AMOSTRA_MINIMA_CLV) return { veredito: "AMOSTRA_CURTA", tStat };
  // Dispersão nula tem critério de sinal próprio, sem significância calculada.
  if (effectivelyZeroSd) {
    return { veredito: m > 0 ? "EDGE" : m < 0 ? "SEM_EDGE" : "INCONCLUSIVO", tStat: null };
  }
  if (tStat === null || !Number.isFinite(tStat)) return { veredito: "INCONCLUSIVO", tStat: null };
  const tCrit = tCritico95(n - 1);
  if (tStat >= tCrit) return { veredito: "EDGE", tStat };
  if (tStat <= -tCrit) return { veredito: "SEM_EDGE", tStat };
  return { veredito: "INCONCLUSIVO", tStat };
}

export function vereditoEdge(clvs: number[]): { veredito: EdgeVeredito; tStat: number | null } {
  const finiteClvs = clvs.filter(Number.isFinite);
  return vereditoEdgeFromStats(
    finiteClvs.length,
    media(finiteClvs),
    desvioPadraoAmostral(finiteClvs),
  );
}

// ───────────── Faixas padrão de CLV (fonte única) ─────────────

export const CLV_CORTES: Array<[string, (v: number) => boolean]> = [
  ["< −5%", (v) => v < -5],
  ["−5–0%", (v) => v >= -5 && v < 0],
  ["0–5%", (v) => v >= 0 && v < 5],
  ["5–10%", (v) => v >= 5 && v < 10],
  ["≥ 10%", (v) => v >= 10],
];

/**
 * Agregado padrão de um grupo de apostas (linha de tabela do analyzer).
 *
 * `membros` é o array EXATO que produziu os números — não uma cópia, não um
 * predicado que se possa reaplicar depois. A gaveta que abre ao clicar na linha
 * renderiza esse array, então não existe o que divergir entre o que a linha
 * conta e o que a gaveta lista. Predicado re-derivado na tela faz a linha dizer
 * 12 e o detalhe abrir 11, com número plausível dos dois lados.
 *
 * Só referências: o custo é ponteiro, não cópia de aposta.
 */
export type GrupoAgg<T extends BetAggInput = BetRowData> = {
  membros: T[];
  /** Quantas apostas no grupo — `membros.length`, exposto como número. */
  bets: number;
  /** Apostas com efeito financeiro usadas em stake/lucro/ROI. */
  resolvedBets: number;
  /** Apostas ainda sem resultado; reembolsos encerrados não são pendências. */
  pendingBets: number;
  /** Apostas com CLV confiável — amostra das métricas de CLV. */
  nClv: number;
  stake: number;
  lucro: number;
  roi: number | null;
  sucessoPct: number | null;
  avgClv: number | null;
  pctPositiveClv: number | null;
};

/**
 * Genérico para preservar o tipo do chamador em `membros` (mesmo padrão de
 * `resolvidas` acima): quem entrega `BetRowData[]` recebe `BetRowData[]` de
 * volta e a gaveta enxerga evento/odds/seleção, sem cast.
 */
export function agregaGrupo<T extends BetAggInput>(grupo: T[]): GrupoAgg<T> {
  const fin: T[] = [];
  const clvValues: number[] = [];
  let clvPositive = 0;
  let pendingBets = 0;
  const hitCounts = { won: 0, lost: 0, halfWon: 0, halfLost: 0 };
  for (const bet of grupo) {
    if (typeof bet.status !== "string") continue;
    const s = typeof bet.status === "string" ? bet.status.trim().toUpperCase() : "";
    if (RESOLVIDOS.has(s)) fin.push(bet);
    if (s === "PENDING") pendingBets += 1;
    switch (s) {
      case "WON": hitCounts.won += 1; break;
      case "LOST": hitCounts.lost += 1; break;
      case "HALF_WON": hitCounts.halfWon += 1; break;
      case "HALF_LOST": hitCounts.halfLost += 1; break;
    }
    const clv = clvConfiavel(bet);
    if (clv !== null) {
      clvValues.push(clv);
      if (clv > 0) clvPositive += 1;
    }
  }
  const stake = sumMoneyBy(fin, (b) => b.stake);
  const lucro = sumMoneyBy(fin, (b) => b.lucro);
  const nClv = clvValues.length;
  return {
    membros: grupo,
    bets: grupo.length,
    resolvedBets: fin.length,
    pendingBets,
    nClv,
    stake,
    lucro,
    roi: roiPct(lucro, stake),
    sucessoPct: hitRateFromCounts(hitCounts),
    avgClv: media(clvValues),
    pctPositiveClv: nClv > 0 ? (clvPositive / nClv) * 100 : null,
  };
}

/** Chave de semana ISO-ish "Sxx" usando a semana SP já existente no domain. */
export function ordenaPorData(bets: BetRowData[]): BetRowData[] {
  return [...bets].sort(compareBetTimeline);
}

/** Kickoff e id formam a ordem estável também usada no SELECT e no CSV. */
export function compareBetTimeline(a: { data: Date; id?: string }, b: { data: Date; id?: string }): number {
  return a.data.getTime() - b.data.getTime() || ((a.id ?? "") < (b.id ?? "") ? -1 : (a.id ?? "") > (b.id ?? "") ? 1 : 0);
}

/** Não disponibiliza no passado o CLV que a busca pós-jogo ou a correção completou depois. */
export function closingEvidenceKnownAt(b: Pick<BetRowData, "closingFetchedAt" | "closingUpdatedAt">): Date | null {
  if (!b.closingFetchedAt) return null;
  return new Date(Math.max(b.closingFetchedAt.getTime(), b.closingUpdatedAt?.getTime() ?? -Infinity));
}
