import { renderDesignMarkup } from "../helpers/design-markup";
import { describe, expect, it } from "vitest";
import {
  deriveMonitoramentoSummary,
  type MonitoramentoSummary,
} from "@/src/domain/monitoramento-health";
import { motivosDeAtencao } from "@/src/domain/motivos-de-atencao";
import { MonitoramentoHeader, textoDeAtencao } from "@/app/_design/screens/operacoes/monitoramento-header";

/**
 * Veredito não é publicado sem a causa que o produziu.
 *
 * O pill VERMELHO "Atenção necessária" do cabeçalho do Monitoramento tem de
 * dizer os motivos que `deriveMonitoramentoSummary` já separa. Sem eles, o pill
 * e o cartão logo abaixo ("Nada aberto — o motor está consistente") podem dar
 * duas frases sobre o mesmo estado, e a mais alarmante sem meio de ser
 * conferida.
 *
 * Família do `estado-terminal-declara-motivo` e do
 * `falha-de-job-diagnosticavel`: nomear o estado sem dizer por quê é o mesmo
 * defeito, uma camada acima.
 */

function resumo(overrides: Partial<Parameters<typeof deriveMonitoramentoSummary>[0]> = {}) {
  return deriveMonitoramentoSummary({
    available: true,
    workerOk: true,
    bancoOk: true,
    closingOk: true,
    jobsAvailable: true,
    jobFailureTotal: 0,
    openActions: 0,
    ackedActions: 0,
    sloBreachTotal: 0,
    channelStates: ["healthy"],
    orphanChannelTotal: 0,
    ...overrides,
  });
}

function html(summary: MonitoramentoSummary) {
  return renderDesignMarkup(
    <MonitoramentoHeader summary={summary} />,
  );
}

describe("quem decide a cor entrega a causa", () => {
  it("saúde consistente não inventa motivo", () => {
    const saudavel = resumo();
    expect(saudavel.state).toBe("healthy");
    expect(motivosDeAtencao(saudavel)).toEqual([]);
    expect(textoDeAtencao(saudavel)).toBeNull();
  });

  it("leitura indisponível não vira alarme com causa", () => {
    const cego = resumo({ available: false });
    expect(motivosDeAtencao(cego)).toEqual([]);
    expect(html(cego)).toContain("Leitura indisponível");
  });

  it("1 ação assumida e 5 canais degradados saem escritos na tela", () => {
    const degradado = resumo({
      ackedActions: 1,
      channelStates: ["healthy", "degraded", "degraded", "degraded", "degraded", "degraded"],
    });
    const saida = html(degradado);
    expect(saida).toContain("Atenção necessária");
    expect(saida).toContain("5 canais degradados");
    expect(saida).toContain("1 ação na fila");
  });

  it("cada motivo concorda em número", () => {
    expect(textoDeAtencao(resumo({ channelStates: ["degraded"] }))).toContain("1 canal degradado");
    expect(textoDeAtencao(resumo({ openActions: 3 }))).toContain("3 ações na fila");
    expect(textoDeAtencao(resumo({ sloBreachTotal: 1 }))).toContain("1 SLO violado");
    expect(textoDeAtencao(resumo({ sloBreachTotal: 2 }))).toContain("2 SLOs violados");
  });

  it("motor e jobs também se nomeiam", () => {
    expect(textoDeAtencao(resumo({ closingOk: false }))).toContain("motor");
    expect(textoDeAtencao(resumo({ jobFailureTotal: 2 }))).toContain("jobs");
  });

  it("estado degradado SEMPRE tem pelo menos um motivo nomeável", () => {
    // Fail-closed: se algum ramo pintar de vermelho sem entrar em
    // `motivosDeAtencao`, o pill volta a ser um alarme mudo.
    const casos = [
      resumo({ workerOk: false }),
      resumo({ bancoOk: false }),
      resumo({ closingOk: false }),
      resumo({ jobsAvailable: false }),
      resumo({ jobFailureTotal: 1 }),
      resumo({ openActions: 1 }),
      resumo({ ackedActions: 1 }),
      resumo({ sloBreachTotal: 1 }),
      resumo({ channelStates: ["degraded"] }),
      resumo({ channelStates: ["unknown"] }),
      resumo({ orphanChannelTotal: 2 }),
    ];
    for (const caso of casos) {
      expect(caso.state, "o caso deveria estar degradado").toBe("degraded");
      expect(motivosDeAtencao(caso).length, "degradado sem motivo nomeável").toBeGreaterThan(0);
      expect(textoDeAtencao(caso)!.length).toBeGreaterThan(3);
    }
  });
});
