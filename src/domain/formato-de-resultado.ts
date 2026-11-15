import { roundMoney } from "./money";
/**
 * Como um número do produto aparece — na tela e no Telegram. Uma implementação
 * só: cópias locais divergem no sinal do zero.
 *
 * 1. **Zero sem sinal.** `+` afirma ganho e `-` afirma perda; aposta anulada
 *    é `0.00u`, não `+0.00u`.
 * 2. **Sinal decidido pelo texto exibido, não pelo valor bruto.** `-0.004`
 *    arredonda para `0.00`, e `-0.00u` afirmaria uma perda que a linha não
 *    mostra. O sinal se decide depois do arredondamento.
 *
 * Vive em `domain/` porque não tem I/O e porque o servidor também formata
 * resultado (avisos de liquidação) — o design não pode ser a casa de algo que o
 * worker precisa.
 */

/**
 * Hífen ASCII de propósito, não o U+2212 tipográfico: número deste painel é
 * copiado para planilha, e o menos matemático não é lido como número. Em Geist
 * Mono os dois ocupam a mesma célula.
 *
 * A regra vale para VALOR. Rótulo de faixa e prosa continuam com o U+2212
 * ("< −5%", "−5 a −2%", "p − (1−p)/(odd−1)"), onde ele é a tipografia certa e
 * ninguém copia como número — não unifique os dois grupos.
 */
const MENOS = "-";

const VAZIO = "—";

/**
 * `positivo` diz se ganho leva `+`. Perda sempre leva o traço; zero nunca leva
 * nada — é o ponto de todo este módulo.
 */
function comSinal(n: number, casas: number, sufixo: string, positivo: boolean): string {
  const rounded = roundMoney(Math.abs(n), casas);
  const absoluto = rounded.toFixed(casas);
  const exibeZero = Number(absoluto) === 0;
  const sinal = exibeZero ? "" : n < 0 ? MENOS : positivo ? "+" : "";
  return `${sinal}${absoluto}${sufixo}`;
}

/** Resultado em unidades, com sinal: "+1.25u", "-0.50u", "0.00u". */
export function fmtU(n: number | null | undefined, signed = true): string {
  return n == null || !Number.isFinite(n) ? VAZIO : comSinal(n, 2, "u", signed);
}

/** Quantidade em unidades, sem "+" (stake, volume): "2.00u". */
export function fmtUnit(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? VAZIO : comSinal(n, 2, "u", false);
}

/** Percentual com sinal (ROI, CLV, movimento): "+3.1%", "-2.0%", "0.0%". */
export function fmtPct(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? VAZIO : comSinal(n, 1, "%", true);
}

/** Diferença entre dois percentuais, em pontos percentuais: "+1.2 p.p.", "-0.4 p.p.". */
export function fmtPp(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? VAZIO : comSinal(n, 1, " p.p.", true);
}

/**
 * Taxa sem sinal (acerto, win rate): "54.3%". Uma casa em toda tela, para o
 * mesmo acerto não aparecer como "54%" numa e "54.3%" noutra.
 */
export function fmtRate(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? VAZIO : comSinal(n, 1, "%", false);
}

/** Odd: três casas, sem sinal. */
export function fmtOdds(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? VAZIO : roundMoney(n, 3).toFixed(3);
}

const REAIS = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Reais: "R$ 1.234,56", "-R$ 12,50", "R$ 0,00". Perda sempre leva o traço,
 * porque saldo negativo existe (a perda de aposta não tem piso) e sem ele
 * leria como dinheiro disponível. `signed` põe "+" no ganho (resultado,
 * movimentação); saldo e totais ficam sem ele.
 */
export function fmtBrl(n: number | null | undefined, signed = false): string {
  if (n == null || !Number.isFinite(n)) return VAZIO;
  const absoluto = roundMoney(Math.abs(n), 2);
  const sinal = absoluto === 0 ? "" : n < 0 ? MENOS : signed ? "+" : "";
  return `${sinal}R$ ${REAIS.format(absoluto)}`;
}

const REAIS_INTEIROS = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const REAIS_EM_MIL = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });

/**
 * Reais curtos para eixo e rótulo de barra, onde "+R$ 1.234,56" não cabe:
 * "+R$ 1,2 mil", "-R$ 850", "R$ 0". Abaixo de mil, reais inteiros: "146,6"
 * leria como centavos cortados. O sinal segue o texto exibido.
 */
function fmtBrlCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return VAZIO;
  const inteiro = Math.round(Math.abs(n));
  const texto = (inteiro < 1000 ? REAIS_INTEIROS : REAIS_EM_MIL).format(inteiro);
  const sinal = texto === "0" ? "" : n < 0 ? MENOS : "+";
  return `${sinal}R$ ${texto}`;
}

/**
 * Como uma tela escreve dinheiro. Dentro de uma banca, em unidades; somando
 * bancas (a carteira), em reais, porque cada banca tem o seu valor de unidade
 * e somar "u" de bancas diferentes não mede nada.
 */
export type MoneyFormat = {
  /** Resultado com sinal: lucro, drawdown, diferença entre janelas. */
  signed: (n: number | null | undefined) => string;
  /** Quantidade sem "+": stake, volume. */
  amount: (n: number | null | undefined) => string;
  /** Eixo de gráfico e rótulo de barra. */
  axis: (n: number | null | undefined) => string;
  /** Como a legenda de um gráfico nomeia a unidade ("lucro em unidades"). */
  unitName: string;
};

export const UNITS_FORMAT: MoneyFormat = {
  signed: (n) => fmtU(n),
  amount: fmtUnit,
  axis: (n) => fmtU(n),
  unitName: "unidades",
};

export const BRL_FORMAT: MoneyFormat = {
  signed: (n) => fmtBrl(n, true),
  amount: (n) => fmtBrl(n),
  axis: fmtBrlCompact,
  unitName: "reais",
};

const REAIS_POR_UNIDADE = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });

/** Valor da unidade da banca: "R$50/u", "R$12,5/u". */
export function fmtBrlPerUnit(valorUnidade: number): string {
  return `R$${REAIS_POR_UNIDADE.format(valorUnidade)}/u`;
}
