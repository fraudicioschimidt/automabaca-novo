import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  countActiveDeadLetters: vi.fn(async (since?: Date) => since ? 0 : 1),
  trainingCount: vi.fn(async () => 0),
  sharpCount: vi.fn(async () => 0),
}));

vi.mock("@/src/services/ops/dlq/pgboss-queues", () => ({
  countActiveDeadLetters: mocks.countActiveDeadLetters,
}));
vi.mock("@/src/infra/prisma", () => ({
  prisma: {
    trainingCase: { count: mocks.trainingCount },
    betSharp: { count: mocks.sharpCount },
  },
}));

import { getAlertas } from "@/src/services/painel/operacoes/alertas";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("alerta resumido de dead-letter", () => {
  it("não deixa uma DLQ ainda ativa expirar por idade", async () => {
    const alertas = await getAlertas({
      ultimoHeartbeat: new Date(),
      ultimoClosing: new Date(),
      dbOk: true,
    });

    expect(mocks.countActiveDeadLetters).toHaveBeenCalledWith();
    expect(alertas).toContainEqual(expect.objectContaining({
      id: "dlq",
      kind: "warn",
      title: "1 falha de job",
    }));
    expect(alertas).not.toContainEqual(expect.objectContaining({ id: "ok" }));
  });
});

describe("alertas de identidade", () => {
  it("o sino conta a sem par fora de Vincular, e não a que ainda aguarda a Pinnacle", async () => {
    mocks.countActiveDeadLetters.mockResolvedValueOnce(0);
    mocks.trainingCount.mockResolvedValueOnce(1);
    // UNMATCHED no total, e a que também está em Vincular.
    mocks.sharpCount.mockResolvedValueOnce(3).mockResolvedValueOnce(1);

    const alertas = await getAlertas({ ultimoHeartbeat: new Date(), ultimoClosing: new Date(), dbOk: true });

    expect(alertas).toContainEqual(expect.objectContaining({ id: "treino", title: "1 jogo para vincular" }));
    expect(alertas).toContainEqual(expect.objectContaining({ id: "sharp", title: "2 apostas sem par sharp" }));
  });
});

it("o sino usa o mesmo frescor do motor da leitura, mesmo se a resposta chegar depois do limite", async () => {
  const readAt = new Date("2026-10-11T12:00:00Z");
  const saude = { ultimoHeartbeat: readAt, ultimoClosing: readAt, dbOk: true };
  mocks.countActiveDeadLetters.mockResolvedValueOnce(0);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-11T12:30:00Z"));
  try {
    const alerts = await getAlertas(saude, readAt);
    expect(alerts).not.toContainEqual(expect.objectContaining({ id: "worker" }));
    expect(alerts).toContainEqual(expect.objectContaining({ id: "ok" }));
  } finally { vi.useRealTimers(); }
});
