import { useMemo, type ReactNode } from "react";
import type { BetRowData } from "@/src/domain/bet-read-model";
import type { AnalyzerPeriod } from "@/src/domain/analyzer-query";
import type { AnalyzerScreenProps } from "../../screen-types";
import type { EmCurso } from "../../lib/balde-em-curso";
import type { recorteDaLinha } from "../../lib/recorte-de-apostas";
import { inAnalyzerRange, inAnalyzerRangeAnterior, janelaAnteriorDoRange, janelaDoRange, rotuloDoPeriodoAnterior, textoDaJanela } from "../../lib/analyzer-range";
import { emCursoDoGrupo } from "../../lib/balde-em-curso";
import { testedAnData } from "../../lib/tested-analyzer";
import { unpackAnalyzerBets } from "../../lib/analyzer-pack";
import { spDayKey } from "@/src/domain/dates";
import type { AnalyzerTab } from "./header";

/** A dimensão da aba Segmentos, a mesma que `segData` agrupa. */
export type SegView = Parameters<typeof testedAnData.segData>[0];

const BANKROLL_SEG_VIEWS: readonly SegView[] = ['esporte', 'mercado', 'competicao', 'pais'];
const PORTFOLIO_SEG_VIEWS: readonly SegView[] = ['canal', ...BANKROLL_SEG_VIEWS];

/** As dimensões que a tela oferece: Canal só na carteira, onde há mais de uma banca. */
export function segViewsOf(portfolio: boolean): readonly SegView[] {
  return portfolio ? PORTFOLIO_SEG_VIEWS : BANKROLL_SEG_VIEWS;
}

/**
 * As apostas do recorte e as agregações da aba visível.
 *
 * Só a aba aberta é calculada: o código das abas já carrega sob demanda, e os
 * cálculos também precisam respeitar isso em históricos longos.
 *
 * O comparativo roda as MESMAS funções puras (`D`/`E`/`S`) sobre a janela
 * anterior: comparar é recalcular sobre outro conjunto, o que garante que os
 * dois lados saiam do mesmo jeito. Com `range = 'tudo'` não há anterior.
 */
export function useAnaliseDoRecorte({ data, tab, segView, range }: {
  data: AnalyzerScreenProps["data"];
  tab: AnalyzerTab;
  segView: SegView;
  range: AnalyzerPeriod;
}) {
  const SRC_BETS = useMemo(() => data ? unpackAnalyzerBets(data.bets) : [], [data]);
  // Sem dado não há "hoje" do servidor; vale o dia corrente de São Paulo.
  const todayKey = data?.today || spDayKey(new Date());
  const FB = useMemo(() => SRC_BETS.filter((b) => inAnalyzerRange(b.day, todayKey, range, b.status === "PENDING")), [range, SRC_BETS, todayKey]);

  const showD = tab === 'overview';
  const showE = tab === 'clv';
  const showS = tab === 'steam';
  const showZ = tab === 'timing' || tab === 'liquidez' || tab === 'segmentos';
  const showP = tab === 'casas' || tab === 'periodo';
  const showSeg = tab === 'segmentos';
  const D = useMemo(() => showD ? testedAnData.D(FB) : null, [showD, FB]);
  const E = useMemo(() => showE ? testedAnData.E(FB) : null, [showE, FB]);
  const S = useMemo(() => showS ? testedAnData.S(FB) : null, [showS, FB]);
  const Z = useMemo(() => showZ ? testedAnData.Z(FB) : null, [showZ, FB]);
  const segData = useMemo(() => showSeg && Z ? testedAnData.segData(segView, Z, FB) : null, [showSeg, segView, Z, FB]);
  // A dimensão Canal só existe na carteira; a matriz e os cortes vêm com ela.
  const showC = showSeg && segView === 'canal';
  const C = useMemo(() => showC ? testedAnData.C(FB) : null, [showC, FB]);
  const P = useMemo(() => showP ? testedAnData.P(FB) : null, [showP, FB]);
  // O simulador não tem comparativo: ele já refaz o recorte inteiro, aposta a aposta.
  const showK = tab === 'simulador';
  const K = useMemo(() => showK ? testedAnData.K(FB) : null, [showK, FB]);

  // A extensão sai da MESMA regra que filtra; em `tudo` ela é a do dado.
  const janela = useMemo(
    () => janelaDoRange(range, todayKey, FB.map((b) => b.day)),
    [range, todayKey, FB],
  );
  // No recorte com prazo, as pendentes de jogo futuro ficam fora das datas que o cartão mostra.
  const futurePending = useMemo(
    () => (range === 'tudo' ? 0 : FB.filter((b) => b.day > todayKey).length),
    [range, FB, todayKey],
  );
  const rotuloAnterior = rotuloDoPeriodoAnterior(range);
  const janelaAnterior = textoDaJanela(janelaAnteriorDoRange(range, todayKey));
  const FB_ANT = useMemo(() => (
    rotuloAnterior ? SRC_BETS.filter((b) => inAnalyzerRangeAnterior(b.day, todayKey, range)) : []
  ), [rotuloAnterior, range, SRC_BETS, todayKey]);
  // Sem contagem de apostas da janela: cada KPI passa a base da PRÓPRIA métrica
  // (ver `comparacao-de-janelas`).
  const anterior = useMemo(() => (
    rotuloAnterior
      ? {
          rotulo: rotuloAnterior,
          D: showD ? testedAnData.D(FB_ANT) : null,
          E: showE ? testedAnData.E(FB_ANT) : null,
          S: showS ? testedAnData.S(FB_ANT) : null,
        }
      : null
  ), [rotuloAnterior, FB_ANT, showD, showE, showS]);

  // O que na janela ATUAL ainda não liquidou: a outra metade da comparação.
  // Só PENDING: a ausência de efeito financeiro não torna um reembolso pendente.
  const emCursoAtual = useMemo(
    () => emCursoDoGrupo({ bets: FB.length, pendingBets: FB.filter((b) => b.status === "PENDING").length }),
    [FB],
  );

  return { todayKey, FB, D, E, S, Z, segData, C, P, K, janela, futurePending, rotuloAnterior, janelaAnterior, anterior, emCursoAtual };
}

export type AnaliseDoRecorte = ReturnType<typeof useAnaliseDoRecorte>;
/** O que a gaveta abre: título, contexto, as apostas e o resumo da linha clicada. */
export type RecorteDeApostas = ReturnType<typeof recorteDaLinha<BetRowData>>;

/** O que toda aba recebe do `AnalyzerScreen`; cada uma lê só o que usa. */
export type PropsDaAba = {
  periodCard: ReactNode;
  FB: AnaliseDoRecorte["FB"];
  anterior: AnaliseDoRecorte["anterior"];
  emCursoAtual: EmCurso;
  abrirRecorte: (recorte: RecorteDeApostas) => void;
};
/** Matriz canal × mercado e cortes sugeridos (carteira, dimensão Canal). */
export type DadosDaCarteira = NonNullable<AnaliseDoRecorte["C"]>;
/** As políticas de stake simuladas sobre o recorte (aba Simulador). */
export type StakeSimulationView = NonNullable<AnaliseDoRecorte["K"]>;
/** Uma linha agregada (`agregaGrupo` remapeado): faixa, janela, casa, segmento. */
export type LinhaAgregada = NonNullable<AnaliseDoRecorte["E"]>["clvPerf"][number];
