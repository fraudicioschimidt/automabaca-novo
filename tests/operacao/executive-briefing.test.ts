import { describe, expect, it } from "vitest";
import {
  briefingDay,
  type ExecutiveBriefingData,
  formatarExecutiveBriefing,
  quotasPrincipais,
  spStartOfMonthUtc,
} from "@/src/services/ops/digests/executive-briefing";

const noMatching: NonNullable<ExecutiveBriefingData["matching"]> = {
  trainingQueueBets: 0,
  settled: { automatic: 0, manual: 0 },
  flashscore: { looked: 0, notFoundByReason: {}, notFoundWithBothTeamIds: 0, evidenceErased: 0 },
  catalog: { linkedGames: 0, teamCards: 0, newTeamCards: 0 },
};

describe("executive-briefing", () => {
  it("calcula o início do mês em UTC a partir do fuso SP", () => {
    // 27 de agosto de 2026 às 21:00 SP (28/08 00:00 UTC)
    const dataRef = new Date("2026-08-28T00:00:00.000Z");
    const inicioMes = spStartOfMonthUtc(dataRef);
    // 1 de agosto de 2026 às 00:00 SP = 03:00 UTC
    expect(inicioMes.toISOString()).toBe("2026-08-01T03:00:00.000Z");
  });

  it("formata briefing com lucro positivo, bancas e quotas saudáveis", () => {
    const mockData: ExecutiveBriefingData = {
      dataReferencia: "27/08/2026",
      hoje: {
        totalResolvidas: 8,
        wins: 5,
        losses: 2,
        halfWins: 1,
        halfLosses: 0,
        voids: 0,
        lucroUnidades: 2.8,
        lucroReais: 560,
        stakeFinalizada: 14.4,
        roi: 19.44,
        winRate: 68.8,
      },
      mes: {
        nomeMes: "Agosto",
        totalResolvidas: 42,
        lucroUnidades: 18.45,
        lucroReais: 3690,
        stakeFinalizada: 80,
        roi: 23.06,
      },
      bancas: [
        {
          nome: "Banca Principal",
          lucroUnidades: 12.5,
          saldoUnidades: 150,
          saldoEstimado: 7500,
        },
        {
          nome: "Banca Alavancagem",
          lucroUnidades: 5.95,
          saldoUnidades: 63.8,
          saldoEstimado: 3190,
        },
      ],
      patrimonio: {
        saldoEmContasAtivas: 10690,
        contasAtivas: 3,
        saldoBancasTotal: 10690,
      },
      operacoes: {
        tipsHoje: 10,
        pendentes: 2,
        acoesAbertas: 0,
        identidadeAntesDoJogo: { casadas: 27, total: 28 },
      },
      matching: noMatching,
      quotas: [
        { provider: "flashscore", spent: 380, cap: 9500, pct: 4 },
        { provider: "pinnacle17", spent: 120, cap: 1000, pct: 12 },
        { provider: "pinnacle17", spent: 8, cap: 98, pct: 8 },
      ],
    };

    const texto = formatarExecutiveBriefing(mockData);

    expect(texto).toContain("📊 Resumo do dia · 27/08/2026");
    expect(texto).toContain("No dia: +R$ 560,00 🟢");
    expect(texto).toContain("ROI +19.44% · acerto 68.8% (5 ganhas, 2 perdidas)");
    expect(texto).toContain("Agosto até o dia: +R$ 3.690,00 · ROI +23.06%");
    expect(texto).toContain("Banca Principal: 150.00u · R$ 7.500,00 (+12.50u)");
    expect(texto).toContain("Total: R$ 10.690,00");
    expect(texto).toContain("Nas 3 conta(s) ativa(s): R$ 10.690,00");
    expect(texto).toContain("Apostas do dia: 10 (8 liquidada(s); 2 pendente(s) agora)");
    expect(texto).toContain("Caixa de ações vazia ✅");
    expect(texto).toContain("Jogos do dia casados antes do início: 27 de 28 (96%)");
    expect(texto).toContain("flashscore: 4% (380/9500)");
  });

  it("formata graciosamente dia sem apostas e com alerta operacional", () => {
    const mockVazio: ExecutiveBriefingData = {
      dataReferencia: "27/08/2026",
      hoje: {
        totalResolvidas: 0,
        wins: 0,
        losses: 0,
        halfWins: 0,
        halfLosses: 0,
        voids: 0,
        lucroUnidades: 0,
        lucroReais: 0,
        stakeFinalizada: 0,
        roi: null,
        winRate: null,
      },
      mes: {
        nomeMes: "Agosto",
        totalResolvidas: 10,
        lucroUnidades: -1.2,
        lucroReais: -240,
        stakeFinalizada: 20,
        roi: -6.0,
      },
      bancas: [],
      patrimonio: {
        saldoEmContasAtivas: 0,
        contasAtivas: 0,
        saldoBancasTotal: 0,
      },
      operacoes: {
        tipsHoje: 1,
        pendentes: 1,
        acoesAbertas: 2,
        identidadeAntesDoJogo: { casadas: 0, total: 0 },
      },
      matching: noMatching,
      quotas: [
        { provider: "pinnacle17", spent: 90, cap: 98, pct: 92 },
      ],
    };

    const texto = formatarExecutiveBriefing(mockVazio);

    expect(texto).toContain("Nenhuma aposta liquidada no dia.");
    expect(texto).toContain("Agosto até o dia: -R$ 240,00 · ROI -6.00%");
    expect(texto).toContain("Nenhum tipster cadastrado.");
    expect(texto).toContain("⚠️ 2 ação(ões) esperando você em Monitoramento");
    // Sem jogo no dia não há taxa: "0 de 0" não diz nada.
    expect(texto).not.toContain("casados antes do início");
    // Dia sem nada a contar no casamento: o bloco inteiro some.
    expect(texto).not.toContain("Casamento");
    expect(texto).toContain("pinnacle17: 92% (90/98) ⚠️");
  });

  it("o bloco Casamento mostra só as linhas com número, depois da Operação", () => {
    const withMatching = (matching: ExecutiveBriefingData["matching"]) => formatarExecutiveBriefing({
      dataReferencia: "23/09/2026",
      hoje: { totalResolvidas: 0, wins: 0, losses: 0, halfWins: 0, halfLosses: 0, voids: 0, lucroUnidades: 0,
        lucroReais: 0, stakeFinalizada: 0, roi: null, winRate: null },
      mes: { nomeMes: "Setembro", totalResolvidas: 0, lucroUnidades: 0, lucroReais: 0, stakeFinalizada: 0, roi: null },
      bancas: [], patrimonio: { saldoEmContasAtivas: 0, contasAtivas: 0, saldoBancasTotal: 0 },
      operacoes: { tipsHoje: 0, pendentes: 0, acoesAbertas: 0, identidadeAntesDoJogo: { casadas: 0, total: 0 } },
      matching,
      quotas: [{ provider: "pinnacle17", spent: 90, cap: 98, pct: 92 }],
    });

    const full = withMatching({
      trainingQueueBets: 2,
      settled: { automatic: 18, manual: 3 },
      flashscore: {
        looked: 25,
        notFoundByReason: { kickoff_mismatch: 1, no_candidate: 3, category_guard: 1, below_threshold: 1 },
        notFoundWithBothTeamIds: 1,
        // Olhadas com a evidência apagada: contam nas 25, não num motivo.
        evidenceErased: 2,
      },
      catalog: { linkedGames: 62, teamCards: 340, newTeamCards: 96 },
    });
    expect(full).toContain([
      "• Caixa de ações vazia ✅",
      "",
      "🔗 Casamento",
      "• Vincular: 2 apostas entraram na sua fila",
      "• Liquidadas: 18 no automático, 3 à mão",
      // Mais frequente primeiro; o desfecho sem nome em português sai com o código.
      "• FlashScore sem o jogo: 6 de 25 (3 sem candidato, 1 nome pouco parecido, 1 category_guard, 1 em outro horário)",
      "• FlashScore conhecia os dois times e não achou o jogo: 1",
      "• Catálogos: 62 jogos ligados no dia, 340 times com id do FlashScore (96 novos)",
      "",
      "🔌 Cotas de API (no dia)",
    ].join("\n"));

    const partial = withMatching({
      trainingQueueBets: 1,
      settled: { automatic: 0, manual: 2 },
      flashscore: { looked: 9, notFoundByReason: { ambiguous: 0 }, notFoundWithBothTeamIds: 0, evidenceErased: 0 },
      catalog: { linkedGames: 0, teamCards: 0, newTeamCards: 0 },
    });
    expect(partial).toContain("🔗 Casamento\n• Vincular: 1 aposta entrou na sua fila\n• Liquidadas: 2 à mão\n\n🔌");
    expect(partial).not.toContain("FlashScore");
    expect(withMatching({ ...noMatching, settled: { automatic: 4, manual: 0 } }))
      .toContain("🔗 Casamento\n• Liquidadas: 4 no automático\n");
    // Fichas de dias anteriores e nenhum jogo ligado no dia: a linha sai, com o singular.
    expect(withMatching({ ...noMatching, catalog: { linkedGames: 1, teamCards: 1, newTeamCards: 1 } }))
      .toContain("🔗 Casamento\n• Catálogos: 1 jogo ligado no dia, 1 time com id do FlashScore (1 novo)\n");
    expect(withMatching({ ...noMatching, catalog: { linkedGames: 0, teamCards: 120, newTeamCards: 0 } }))
      .toContain("• Catálogos: 0 jogos ligados no dia, 120 times com id do FlashScore (0 novos)");
    // Leitura do casamento que falhou: o resumo sai inteiro, sem o bloco.
    const unread = withMatching(null);
    expect(unread).not.toContain("Casamento");
    expect(unread).toContain("• Caixa de ações vazia ✅\n\n🔌 Cotas de API (no dia)");
  });

  it("às 00:05 resume o dia de São Paulo que terminou, inteiro", () => {
    // 24/09 00:05 SP = 03:05 UTC. A aposta liquidada às 23:30 do dia 23 entra.
    const dia = briefingDay(new Date("2026-09-24T03:05:00Z"));
    expect(dia.start.toISOString()).toBe("2026-09-23T03:00:00.000Z");
    expect(dia.end.toISOString()).toBe("2026-09-24T03:00:00.000Z");
    const liquidadaAs2330 = new Date("2026-09-24T02:30:00Z");
    expect(liquidadaAs2330 >= dia.start && liquidadaAs2330 < dia.end).toBe(true);
    // Retentativa atrasada ainda resume o mesmo dia.
    expect(briefingDay(new Date("2026-09-24T03:25:00Z")).start.toISOString()).toBe("2026-09-23T03:00:00.000Z");
  });

  it("a cota por hora da BridgeOdds soma o dia e mostra a hora mais cheia", () => {
    // A hora do envio (madrugada) diria ~0%.
    const dia = briefingDay(new Date("2026-09-24T03:05:00Z"));
    const quotas = quotasPrincipais([
      { provider: "bridgeodds", periodKey: "2026-09-23T22", spent: 40 },
      { provider: "bridgeodds", periodKey: "2026-09-24T00", spent: 80 },
      { provider: "bridgeodds", periodKey: "2026-09-24T03", spent: 5 },
      { provider: "pinnacle17", periodKey: "2026-09-23", spent: 120 },
      { provider: "pinnacle17", periodKey: "2026-09-24", spent: 7 },
    ], dia);
    const bridge = quotas.find((q) => q.provider === "bridgeodds");
    expect(bridge?.spent).toBe(120);
    expect(bridge?.peakHour?.spent).toBe(80);
    expect(quotas.find((q) => q.provider === "pinnacle17")?.spent).toBe(120);
    const texto = formatarExecutiveBriefing({
      dataReferencia: "23/09/2026",
      hoje: { totalResolvidas: 0, wins: 0, losses: 0, halfWins: 0, halfLosses: 0, voids: 0, lucroUnidades: 0,
        lucroReais: 0, stakeFinalizada: 0, roi: null, winRate: null },
      mes: { nomeMes: "Setembro", totalResolvidas: 0, lucroUnidades: 0, lucroReais: 0, stakeFinalizada: 0, roi: null },
      bancas: [], patrimonio: { saldoEmContasAtivas: 0, contasAtivas: 0, saldoBancasTotal: 0 },
      operacoes: { tipsHoje: 0, pendentes: 0, acoesAbertas: 0, identidadeAntesDoJogo: { casadas: 0, total: 0 } },
      matching: noMatching,
      quotas,
    });
    expect(texto).toMatch(/bridgeodds: 120 no dia · hora mais cheia \d+% \(80\/\d+\)/);
  });

  it("reais que arredondam para zero saem sem sinal, e saldo negativo com o traço", () => {
    const base: ExecutiveBriefingData = {
      dataReferencia: "27/08/2026",
      hoje: { totalResolvidas: 1, wins: 0, losses: 0, halfWins: 0, halfLosses: 0, voids: 1, lucroUnidades: 0, lucroReais: -0.004, stakeFinalizada: 0, roi: null, winRate: null },
      mes: { nomeMes: "Agosto", totalResolvidas: 1, lucroUnidades: 0, lucroReais: -0.004, stakeFinalizada: 0, roi: null },
      bancas: [{ nome: "Negativa", lucroUnidades: -1, saldoUnidades: -1.25, saldoEstimado: -12.5 }],
      patrimonio: { saldoEmContasAtivas: 0, contasAtivas: 0, saldoBancasTotal: -12.5 },
      operacoes: { tipsHoje: 0, pendentes: 0, acoesAbertas: 0, identidadeAntesDoJogo: { casadas: 0, total: 0 } },
      matching: noMatching,
      quotas: [],
    };
    const texto = formatarExecutiveBriefing(base);
    expect(texto).not.toContain("-R$ 0,00");
    expect(texto).toContain("No dia: R$ 0,00 ⚪");
    expect(texto).toContain("Negativa: -1.25u · -R$ 12,50");
    expect(texto).toContain("Total: -R$ 12,50");
  });

  it("com muitas bancas lista as de maior resultado e cabe numa mensagem do Telegram", () => {
    // Nome de canal do Telegram tem até 128 caracteres, e cada canal novo ganha banca.
    const bankrolls = Array.from({ length: 80 }, (_, i) => ({
      nome: `Canal ${String(i).padStart(2, "0")} ${"x".repeat(119)}`,
      lucroUnidades: i === 7 ? -40 : i / 10,
      saldoUnidades: 100,
      saldoEstimado: 1000,
    }));
    const text = formatarExecutiveBriefing({
      dataReferencia: "23/09/2026",
      hoje: { totalResolvidas: 0, wins: 0, losses: 0, halfWins: 0, halfLosses: 0, voids: 0, lucroUnidades: 0,
        lucroReais: 0, stakeFinalizada: 0, roi: null, winRate: null },
      mes: { nomeMes: "Setembro", totalResolvidas: 0, lucroUnidades: 0, lucroReais: 0, stakeFinalizada: 0, roi: null },
      bancas: bankrolls,
      patrimonio: { saldoEmContasAtivas: 0, contasAtivas: 0, saldoBancasTotal: 80_000 },
      operacoes: { tipsHoje: 0, pendentes: 0, acoesAbertas: 0, identidadeAntesDoJogo: { casadas: 0, total: 0 } },
      matching: noMatching,
      quotas: [{ provider: "pinnacle17", spent: 90, cap: 98, pct: 92 }],
    });

    expect(text.length).toBeLessThan(3_900);
    expect(text).toContain("Canal 79");
    expect(text).toContain("Canal 07");
    expect(text).not.toContain("Canal 00");
    expect(text).toMatch(/• … e mais \d+ tipsters; veja Tipsters no painel\./);
    expect(text).toContain("• Total: R$ 80.000,00");
    expect(text).toContain("pinnacle17: 92% (90/98)");
  });
});


describe("ROI sem base financeira no resumo diário", () => {
  it.each([null, 0])("distingue ROI ausente de equilíbrio medido: %s", (roi) => {
    const data: ExecutiveBriefingData = {
      dataReferencia: "23/09/2026",
      hoje: { totalResolvidas: 2, wins: roi === null ? 0 : 1, losses: roi === null ? 0 : 1,
        halfWins: 0, halfLosses: 0, voids: roi === null ? 2 : 0, lucroUnidades: 0,
        lucroReais: 0, stakeFinalizada: roi === null ? 0 : 2, roi, winRate: roi === null ? null : 50 },
      mes: { nomeMes: "Setembro", totalResolvidas: 2, lucroUnidades: 0, lucroReais: 0, stakeFinalizada: roi === null ? 0 : 2, roi },
      bancas: [], patrimonio: { saldoEmContasAtivas: 0, contasAtivas: 0, saldoBancasTotal: 0 },
      operacoes: { tipsHoje: 0, pendentes: 0, acoesAbertas: 0, identidadeAntesDoJogo: { casadas: 0, total: 0 } },
      matching: null, quotas: [],
    };
    const text = formatarExecutiveBriefing(data);
    expect(text).toContain(roi === null ? "ROI — (sem stake finalizada)" : "ROI 0.00%");
    if (roi === null) expect(text).not.toContain("ROI 0.00%");
  });
});
