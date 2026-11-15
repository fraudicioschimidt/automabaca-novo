import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgBossFailureRow } from "@/src/services/ops/dlq/pgboss-queues";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  count: vi.fn(),
  active: vi.fn(),
  retained: vi.fn(),
  circuits: vi.fn(),
}));

vi.mock("@/src/services/ops/dlq/pgboss-queues", () => ({
  listRecentPgBossFailures: mocks.list,
  countRecentPgBossFailures: mocks.count,
  countActiveDeadLetters: mocks.active,
}));
vi.mock("@/src/services/ops/dlq/repository", () => ({
  findRetainedDeadLetterErrors: mocks.retained,
}));
vi.mock("@/src/infra/prisma", () => ({
  prisma: { providerCircuit: { findMany: mocks.circuits } },
}));

const { getJobFailures } = await import("@/src/services/painel/operacoes/falhas");

const NOW = new Date("2026-08-12T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function falha(id: string, name: string, output: unknown, quando: Date, data: unknown = {}): PgBossFailureRow {
  return { id, name, state: "failed", completed_on: quando, created_on: quando, output, data, retry_count: 1 };
}

const CIRCUITO_BRIDGE = { name: "CircuitOpenError", message: 'circuit breaker aberto para "bridgeodds"' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.circuits.mockResolvedValue([]);
  mocks.active.mockResolvedValue(0);
  mocks.retained.mockResolvedValue(new Map());
});

describe("getJobFailures", () => {
  it("agrupa por (fila, causa), guarda os membros exatos e ordena pelo incidente mais recente", async () => {
    mocks.list.mockResolvedValue([
      falha("j1", "sharp.enrich.dlq", CIRCUITO_BRIDGE, hoursAgo(30), { betId: "bet-a" }),
      falha("j2", "sharp.enrich.dlq", CIRCUITO_BRIDGE, hoursAgo(2)),
      falha("j3", "closing", "algo estranho", hoursAgo(1)),
    ]);
    mocks.count.mockResolvedValue(512);

    const result = await getJobFailures(NOW);

    expect(result.disponivel).toBe(true);
    // O total é o universo da janela, não a página agrupada.
    expect(result.total).toBe(512);
    expect(result.grupos.map((g) => [g.fila, g.causa, g.n])).toEqual([
      ["closing", "desconhecida", 1],
      ["sharp.enrich.dlq", "circuito_aberto", 2],
    ]);
    const circuito = result.grupos[1]!;
    expect(circuito.membros.map((m) => [m.id, m.betId])).toEqual([["j1", "bet-a"], ["j2", null]]);
    expect(circuito.primeira).toEqual(hoursAgo(30));
    expect(circuito.ultima).toEqual(hoursAgo(2));
    const since = mocks.list.mock.calls[0]![0] as Date;
    expect(NOW.getTime() - since.getTime()).toBe(7 * 86_400_000);
  });

  it("só oferece replay para dead-letter, e circuito ainda aberto bloqueia com motivo", async () => {
    mocks.list.mockResolvedValue([
      falha("j1", "sharp.enrich.dlq", CIRCUITO_BRIDGE, hoursAgo(1)),
      falha("j2", "sharp.enrich", CIRCUITO_BRIDGE, hoursAgo(1)),
    ]);
    mocks.count.mockResolvedValue(2);
    mocks.circuits.mockResolvedValue([{ provider: "bridgeodds" }]);

    const [dlq, origem] = (await getJobFailures(NOW)).grupos;
    expect(dlq).toMatchObject({ replayable: true, replayHabilitado: false });
    expect(dlq!.motivoBloqueio).toEqual(expect.any(String));
    expect(origem).toMatchObject({ fila: "sharp.enrich", replayable: false, replayHabilitado: false });
  });

  it("dead-letter retida mostra a causa guardada na retenção, não o sentinela", async () => {
    // O handler falha a cópia com o sentinela para mantê-la na fila; a causa
    // real ficou no registro de auditoria da retenção.
    const sentinela = { name: "Error", message: "Dead-letter j1 retida para replay manual." };
    mocks.list.mockResolvedValue([falha("j1", "sharp.enrich.dlq", sentinela, hoursAgo(1))]);
    mocks.count.mockResolvedValue(1);
    mocks.active.mockResolvedValue(1);
    mocks.retained.mockResolvedValue(new Map([
      ["j1", { errorMsg: "handler execution exceeded 300000ms", dlqClass: "other", waitsFor: null }],
    ]));

    const result = await getJobFailures(NOW);
    expect(mocks.retained).toHaveBeenCalledWith([{ queue: "sharp.enrich", jobId: "j1" }]);
    expect(result.grupos[0]).toMatchObject({ causa: "tempo_esgotado", replayable: true, replayHabilitado: true });
  });

  it("falha da fila de origem é histórico já tratado, e o veredito conta só as retidas", async () => {
    // A origem só aparece quando a cópia já saiu da dead-letter (reenfileirada,
    // descartada ou reprocessada): não há o que fazer por ela.
    mocks.list.mockResolvedValue([falha("j2", "sharp.enrich", CIRCUITO_BRIDGE, hoursAgo(20))]);
    mocks.count.mockResolvedValue(1);
    mocks.active.mockResolvedValue(0);

    const result = await getJobFailures(NOW);
    expect(result.total).toBe(1);
    expect(result.retidas).toBe(0);
    expect(result.grupos[0]).toMatchObject({ replayable: false, motivoBloqueio: null });
    expect(result.grupos[0]!.proximaEtapa).toMatch(/já tratada/i);
  });

  it("circuito que já fechou libera o replay", async () => {
    mocks.list.mockResolvedValue([falha("j1", "sharp.enrich.dlq", CIRCUITO_BRIDGE, hoursAgo(1))]);
    mocks.count.mockResolvedValue(1);
    mocks.circuits.mockResolvedValue([{ provider: "outro" }]);

    const [grupo] = (await getJobFailures(NOW)).grupos;
    expect(grupo).toMatchObject({ replayHabilitado: true, motivoBloqueio: null });
  });

  it("sem falhas não consulta os circuitos", async () => {
    mocks.list.mockResolvedValue([]);
    mocks.count.mockResolvedValue(0);

    expect(await getJobFailures(NOW)).toEqual({ disponivel: true, total: 0, retidas: 0, grupos: [] });
    expect(mocks.circuits).not.toHaveBeenCalled();
  });

  it("pg-boss ilegível vira indisponível, não zero falhas", async () => {
    mocks.list.mockRejectedValue(new Error("relation pgboss.job does not exist"));
    mocks.count.mockResolvedValue(0);

    expect(await getJobFailures(NOW)).toEqual({ disponivel: false, total: 0, retidas: 0, grupos: [] });
  });
});
