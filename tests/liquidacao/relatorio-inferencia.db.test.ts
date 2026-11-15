import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "@/src/infra/env";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * Relatório diário das liquidações por inferência, contra Postgres real.
 *
 * O requisito que este arquivo protege é o SILÊNCIO: dia sem inferência não
 * manda nada. Alerta que chega todo dia deixa de ser lido, e este precisa
 * continuar sendo lido no dia em que trouxer uma divergência de dinheiro.
 */

const notify = vi.fn(async (_mensagem: string) => true);
const requiredNotify = vi.fn<typeof import("@/src/services/ops/alerts").sendRequiredOperatorNotification>(async (message: string) => {
  await notify(message);
  return "delivered" as const;
});

vi.mock("@/src/services/ops/alerts", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    sendOperatorNotification: notify,
    sendRequiredOperatorNotification: requiredNotify,
  };
});

const { sendRelatorioInferencia } = await import("@/src/services/ops/digests/relatorio-inferencia");

let db: TestDb;
const NOW = new Date("2026-08-10T12:00:00Z");
const KICKOFF = new Date("2026-08-09T18:00:00Z");

beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.dispose();
});
beforeEach(async () => {
  await db.reset();
  notify.mockClear();
  requiredNotify.mockClear();
  requiredNotify.mockImplementation(async (message: string) => {
    await notify(message);
    return "delivered" as const;
  });
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetEnvCacheForTests(); });

async function aposta(params: {
  evento: string;
  esporte: string;
  settlementOutcome: string;
  placar: string;
  status?: "WON" | "LOST";
  decididaHaHoras?: number;
  recheck?: { resultado: string; placarAgora: string; em: string };
}): Promise<string> {
  const banca = await db.prisma.bankroll.upsert({
    where: { slug: "rel" },
    create: { nome: "Rel", slug: "rel" },
    update: {},
  });
  const bet = await db.prisma.bet.create({
    data: {
      sportResolvedAt: new Date(),
      settledAt: KICKOFF,
      bankrollId: banca.id,
      data: KICKOFF,
      evento: params.evento,
      esporte: params.esporte,
      mercado: "Moneyline",
      selecao: "Casa",
      odds: 2,
      stake: 1,
      status: params.status ?? "WON",
      sportResolutionStatus: "CONFIRMED",
    },
  });
  await db.prisma.betResult.create({
    data: {
      betId: bet.id,
      resultProvider: "flashscore",
      resultMatchId: "fs-1",
      resultFinal: true,
      resultCheckedAt: new Date(NOW.getTime() - (params.decididaHaHoras ?? 6) * 3_600_000),
      resultSnapshot: {
        outcome: "matched",
        settlementOutcome: params.settlementOutcome,
        placar: params.placar,
        ...(params.recheck ? { recheck: params.recheck } : {}),
      },
    },
  });
  return bet.id;
}

describe("sendRelatorioInferencia (Postgres real)", () => {
  it("a retentativa do mesmo dia não duplica o relatório com números novos", async () => {
    const actual = await vi.importActual<typeof import("@/src/services/ops/alerts")>("@/src/services/ops/alerts");
    requiredNotify.mockImplementation(actual.sendRequiredOperatorNotification);
    vi.stubEnv("TELEGRAM_NOTIFICATION_BOT_TOKEN", "test-token");
    vi.stubEnv("TELEGRAM_NOTIFICATION_CHAT_ID", "123");
    resetEnvCacheForTests();
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const addBet = () => aposta({ evento: "A vs B", esporte: "Baseball", settlementOutcome: "settled_from_score_inferido", placar: "4x1" });
    await addBet();
    await sendRelatorioInferencia(NOW);
    await addBet();
    await sendRelatorioInferencia(new Date(NOW.getTime() + 300_000));
    expect(fetchMock).toHaveBeenCalledOnce();
    // O dia seguinte tem uma liquidação nova, dentro da janela de 24 h.
    const next = await addBet();
    await db.prisma.betResult.update({ where: { betId: next }, data: { resultCheckedAt: new Date(NOW.getTime() + 86_400_000) } });
    await sendRelatorioInferencia(new Date(NOW.getTime() + 86_400_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("dia sem nenhuma inferência não manda mensagem", async () => {
    await aposta({
      evento: "Time A vs Time B",
      esporte: "Soccer",
      settlementOutcome: "settled_from_score",
      placar: "1x0",
    });

    expect(await sendRelatorioInferencia(NOW)).toEqual({
      enviado: false,
      liquidadas: 0,
      divergentes: 0,
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("banco totalmente vazio também não manda mensagem", async () => {
    expect(await sendRelatorioInferencia(NOW)).toMatchObject({ enviado: false });
    expect(notify).not.toHaveBeenCalled();
  });

  it("lista as liquidações por inferência com o atraso desde o kickoff", async () => {
    await aposta({
      evento: "Hanshin Tigers vs Yomiuri Giants",
      esporte: "Baseball",
      settlementOutcome: "settled_from_score_inferido",
      placar: "4x1",
      decididaHaHoras: 6,
    });

    const resultado = await sendRelatorioInferencia(NOW);

    expect(resultado).toMatchObject({ enviado: true, liquidadas: 1, divergentes: 0 });
    const msg = notify.mock.calls[0]![0];
    expect(msg).toContain("Hanshin Tigers vs Yomiuri Giants");
    expect(msg).toContain("Baseball");
    expect(msg).toContain("placar 4x1");
    // Kickoff 09/08 18:00Z, decidida 10/08 06:00Z → 12h.
    expect(msg).toContain("decidida 12h após o início");
  });

  it("liquidação por estatística diz a evidência, não inventa placar", async () => {
    await aposta({
      evento: "Time C vs Time D",
      esporte: "Volleyball",
      settlementOutcome: "settled_from_stats_inferido",
      placar: "3x1",
    });

    await sendRelatorioInferencia(NOW);
    const msg = notify.mock.calls[0]![0];
    expect(msg).toContain("por estatística");
    expect(msg).not.toContain("placar 3x1");
  });

  it("conteúdo existente propaga falha de entrega para o retry do job", async () => {
    await aposta({
      evento: "Time I vs Time J",
      esporte: "Baseball",
      settlementOutcome: "settled_from_score_inferido",
      placar: "3x2",
    });
    requiredNotify.mockRejectedValueOnce(new Error("network_error"));

    await expect(sendRelatorioInferencia(NOW)).rejects.toThrow("network_error");
  });

  it("divergência da rechecagem aparece com o caminho de desfazer", async () => {
    await aposta({
      evento: "Time E vs Time F",
      esporte: "eSports",
      settlementOutcome: "settled_from_score_inferido",
      placar: "2x1",
      recheck: { resultado: "divergente", placarAgora: "2x3", em: NOW.toISOString() },
    });

    const resultado = await sendRelatorioInferencia(NOW);

    expect(resultado).toMatchObject({ liquidadas: 1, divergentes: 1 });
    const msg = notify.mock.calls[0]![0];
    expect(msg).toContain("liquidou com 2x1, agora está 2x3");
    expect(msg).toContain('"Pendente"');
  });

  it("divergência antiga não reaparece no relatório de hoje", async () => {
    await aposta({
      evento: "Time G vs Time H",
      esporte: "Handball",
      settlementOutcome: "settled_from_score_inferido",
      placar: "30x28",
      // Liquidada e reconferida há uma semana: fora das duas janelas de 24h.
      decididaHaHoras: 24 * 7,
      recheck: {
        resultado: "divergente",
        placarAgora: "31x28",
        em: new Date(NOW.getTime() - 6 * 86_400_000).toISOString(),
      },
    });

    expect(await sendRelatorioInferencia(NOW)).toMatchObject({ enviado: false });
    expect(notify).not.toHaveBeenCalled();
  });
});
