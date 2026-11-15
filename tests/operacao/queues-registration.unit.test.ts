import { describe, expect, it, vi } from "vitest";
import { DEAD_LETTER_RETENTION_SECONDS, registerQueue } from "@/src/jobs/queues";

describe("registerQueue", () => {
  it("herda exclusive para sharp.enrich quando o caller omite policy", async () => {
    const boss = {
      getQueue: vi.fn().mockResolvedValue(null),
      createQueue: vi.fn().mockResolvedValue(undefined),
      work: vi.fn().mockResolvedValue(undefined),
    };

    await registerQueue(boss as never, "sharp.enrich");

    expect(boss.createQueue).toHaveBeenCalledWith(
      "sharp.enrich",
      expect.objectContaining({ policy: "exclusive" }),
    );
  });

  it("propaga falha ao consultar a fila em vez de tratá-la como inexistente", async () => {
    const failure = new Error("Postgres indisponível");
    const boss = {
      getQueue: vi.fn().mockRejectedValue(failure),
      createQueue: vi.fn(),
      work: vi.fn(),
    };

    await expect(registerQueue(boss as never, "fila.teste")).rejects.toBe(failure);
    expect(boss.createQueue).not.toHaveBeenCalled();
    expect(boss.work).not.toHaveBeenCalled();
  });

  it("falha fechada em policy divergente sem apagar a fila", async () => {
    const boss = {
      getQueue: vi.fn()
        .mockResolvedValueOnce({
          policy: "standard",
          retryLimit: 0,
          retryDelay: 0,
          retryBackoff: false,
          notify: true,
          deleteAfterSeconds: DEAD_LETTER_RETENTION_SECONDS,
        })
        .mockResolvedValueOnce({ policy: "singleton" }),
      deleteQueue: vi.fn(),
      createQueue: vi.fn().mockResolvedValue(undefined),
      work: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      registerQueue(boss as never, "sharp.enrich", { policy: "exclusive" }),
    ).rejects.toThrow(/policy singleton.*migração operacional explícita.*exclusive/i);

    expect(boss.deleteQueue).not.toHaveBeenCalled();
    expect(boss.createQueue).not.toHaveBeenCalled();
    expect(boss.work).not.toHaveBeenCalled();
  });

  it("atualiza retries mutáveis sem apagar a fila ou seu histórico", async () => {
    const existing = {
      policy: "standard",
      retryLimit: 1,
      retryDelay: 10,
      retryBackoff: false,
      deadLetter: "sharp.enrich__dlq",
      queuedCount: 0,
      activeCount: 0,
    };
    const boss = {
      getQueue: vi.fn()
        .mockResolvedValueOnce({
          name: "sharp.enrich__dlq",
          policy: "standard",
          retryLimit: 0,
          retryDelay: 0,
          retryBackoff: false,
          notify: true,
          deleteAfterSeconds: DEAD_LETTER_RETENTION_SECONDS,
        })
        .mockResolvedValueOnce(existing),
      createQueue: vi.fn(),
      updateQueue: vi.fn().mockResolvedValue(undefined),
      deleteQueue: vi.fn(),
      work: vi.fn().mockResolvedValue(undefined),
    };

    await registerQueue(boss as never, "sharp.enrich", {
      retryLimit: 3,
      retryDelay: 60,
      policy: "standard",
    });

    expect(boss.deleteQueue).not.toHaveBeenCalled();
    expect(boss.updateQueue).toHaveBeenCalledWith(
      "sharp.enrich",
      expect.objectContaining({
        retryLimit: 3,
        retryDelay: 60,
        retryBackoff: true,
        notify: true,
      }),
    );
  });

  it("leva retryBackoff junto quando só o teto do backoff diverge", async () => {
    // O pg-boss valida o par: `retryDelayMax` sem `retryBackoff: true` no mesmo
    // payload é recusado no `attorney`, e quem paga é o BOOT DO WORKER — a
    // exceção sobe antes de qualquer fila subir. Só o teto divergir é o caso
    // real de quem ajusta a cauda do backoff depois, sem tocar no resto.
    const existing = {
      policy: "exclusive",
      retryLimit: 12,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 900,
      deadLetter: "sharp.enrich__dlq",
      queuedCount: 0,
      activeCount: 0,
    };
    const boss = {
      getQueue: vi.fn()
        .mockResolvedValueOnce({
          name: "sharp.enrich__dlq",
          policy: "standard",
          retryLimit: 0,
          retryDelay: 0,
          retryBackoff: false,
          notify: true,
          deleteAfterSeconds: DEAD_LETTER_RETENTION_SECONDS,
        })
        .mockResolvedValueOnce(existing),
      createQueue: vi.fn(),
      updateQueue: vi.fn().mockResolvedValue(undefined),
      deleteQueue: vi.fn(),
      work: vi.fn().mockResolvedValue(undefined),
    };

    await registerQueue(boss as never, "sharp.enrich", {
      retryLimit: 12,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 1800,
      policy: "exclusive",
    });

    const [, drift] = boss.updateQueue.mock.calls[0] as [string, Record<string, unknown>];
    expect(drift.retryDelayMax).toBe(1800);
    expect(drift.retryBackoff).toBe(true);
  });

  it("a dead-letter guarda a falha por 90 dias, inclusive a fila que já existia com os 7 do pg-boss", async () => {
    // Com os 7 dias padrão do pg-boss, a falha retida sumiria antes de alguém decidir.
    expect(DEAD_LETTER_RETENTION_SECONDS).toBe(90 * 24 * 60 * 60);
    const nova = {
      getQueue: vi.fn().mockResolvedValue(null),
      createQueue: vi.fn().mockResolvedValue(undefined),
      work: vi.fn().mockResolvedValue(undefined),
    };
    await registerQueue(nova as never, "closing.price_series");
    expect(nova.createQueue).toHaveBeenCalledWith(
      "closing.price_series.dlq",
      expect.objectContaining({ deleteAfterSeconds: DEAD_LETTER_RETENTION_SECONDS }),
    );

    const antiga = {
      getQueue: vi.fn()
        .mockResolvedValueOnce({
          name: "closing.price_series.dlq", policy: "standard", retryLimit: 0, retryDelay: 0,
          retryBackoff: false, notify: true, deleteAfterSeconds: 604_800,
        })
        .mockResolvedValueOnce(null),
      createQueue: vi.fn().mockResolvedValue(undefined),
      updateQueue: vi.fn().mockResolvedValue(undefined),
      work: vi.fn().mockResolvedValue(undefined),
    };
    await registerQueue(antiga as never, "closing.price_series");
    expect(antiga.updateQueue).toHaveBeenCalledWith("closing.price_series.dlq", {
      deleteAfterSeconds: DEAD_LETTER_RETENTION_SECONDS,
    });
  });
});
