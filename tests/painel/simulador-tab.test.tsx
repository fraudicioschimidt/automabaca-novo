import { describe, expect, it } from "vitest";
import { renderDesignMarkup } from "../helpers/design-markup";
import { StakeSimulatorTab } from "@/app/_design/screens/analyzer/simulador-tab";
import { MoneyFormatContext } from "@/app/_design/screens/analyzer/ui-primitives";
import { testedAnData } from "@/app/_design/lib/tested-analyzer";
import { unpackAnalyzerBets } from "@/app/_design/lib/analyzer-pack";
import { ANALYZER_PORTFOLIO_MOCK_DATA } from "@/app/_design/mock/analyzer-data";
import { BRL_FORMAT, UNITS_FORMAT } from "@/src/domain/formato-de-resultado";

/** A aba Simulador do Analyzer: as políticas, a curva de cada uma e os avisos de leitura. */

const PORTFOLIO = unpackAnalyzerBets(ANALYZER_PORTFOLIO_MOCK_DATA.bets);
/** Uma banca da carteira sintética, de volta às unidades: dezenas de liquidadas com CLV. */
const BANKROLL = PORTFOLIO.filter((b) => b.bankrollName === "Gols & Cantos")
  .map(({ bankrollName: _channel, valorUnidade = 1, ...b }) => ({ ...b, stake: b.stake / valorUnidade, lucro: b.lucro / valorUnidade }));
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

function render(bets: typeof BANKROLL, { portfolio = false, wholeHistory = true } = {}) {
  const K = testedAnData.K(bets);
  return renderDesignMarkup(
    <MoneyFormatContext value={portfolio ? BRL_FORMAT : UNITS_FORMAT}>
      <StakeSimulatorTab periodCard={null} K={K} portfolio={portfolio} wholeHistory={wholeHistory} />
    </MoneyFormatContext>,
  );
}

describe("aba Simulador", () => {
  it("compara as três políticas com a amostra de cada uma, a curva e os avisos de viés", () => {
    const html = render(BANKROLL);
    const t = textOf(html);
    for (const name of ["Stake do tipster", "1u fixa", "Só com canal em Manter"]) {
      expect(t).toContain(name);
    }
    for (const column of ["Apostas", "Drawdown máx.", "Maior stake"]) expect(t).toContain(column);
    // No celular a tabela vira uma list com lucro, ROI e drawdown à vista.
    expect(html.match(/aria-label="Políticas de stake"[\s\S]*?<\/ul>/)?.[0].match(/<li/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Lucro acumulado de cada política de stake"');
    expect(html.match(/data-curve=/g)).toHaveLength(3);
    // O viés de seleção e de onde a régua do canal parte.
    expect(t).toContain("👎");
    expect(t).toContain("começa na primeira aposta do histórico");
    expect(t).not.toContain("Amostra pequena");
  });

  it("avisa a amostra pequena e o recorte que recomeça no início", () => {
    const few = BANKROLL.filter((b) => b.status !== "PENDING").slice(0, 5);
    const t = textOf(render(few, { wholeHistory: false }));
    expect(t).toContain("Amostra pequena: 5 liquidadas");
    expect(t).toContain("recomeça no início deste recorte");
  });

  it("a política que não apostou fica com traço, não com lucro zero", () => {
    // Cinco liquidadas não dão os fechamentos do veredito Manter: a política não aposta.
    const few = BANKROLL.filter((b) => b.status !== "PENDING").slice(0, 5);
    const list = render(few).match(/aria-label="Políticas de stake"[\s\S]*?<\/ul>/)?.[0] ?? "";
    const edgeOnly = textOf(`<li${list.split("<li").find((li) => li.includes("Só com canal em Manter")) ?? ""}`);
    expect(edgeOnly).toContain("0 apostas");
    expect(edgeOnly).toMatch(/Lucro — ROI — Drawdown máx\. —/);
    expect(edgeOnly).not.toMatch(/0\.00u/);
  });

  it("a política que não apostou fica fora do gráfico, com o nome dela abaixo", () => {
    const few = BANKROLL.filter((b) => b.status !== "PENDING").slice(0, 5);
    const html = render(few);
    const idle = testedAnData.K(few).rows.filter((r) => r.n === 0).map((r) => r.policy);
    expect(idle).toContain("edgeOnly");
    for (const policy of idle) expect(html).not.toContain(`data-curve="${policy}"`);
    expect(html).toContain('data-curve="tipster"');
    expect(textOf(html)).toMatch(/Só com canal em Manter[^.]*: sem aposta no recorte/);
  });

  it("concorda o número com uma liquidada só", () => {
    const one = BANKROLL.filter((b) => b.status !== "PENDING").slice(0, 1);
    const t = textOf(render(one));
    expect(t).toContain("A 1 aposta liquidada do recorte refeita com outra regra");
    expect(t).not.toContain("As 1 ");
  });

  it("sem liquidada no recorte não simula nada", () => {
    const t = textOf(render(BANKROLL.filter((b) => b.status === "PENDING")));
    expect(t).toContain("Nenhuma aposta liquidada no recorte");
    expect(t).not.toContain("1u fixa");
  });

  it("na carteira escreve em reais e cada tipster decide com a régua dele", () => {
    const t = textOf(render(PORTFOLIO, { portfolio: true }));
    expect(t).toContain("R$");
    expect(t).not.toMatch(/\d\.\d\du\b/);
    expect(t).toContain("cada tipster decide com a régua dele");
  });
});
