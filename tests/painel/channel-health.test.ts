import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  queryRaw: vi.fn(),
}));

vi.mock("@/src/infra/prisma", () => ({
  prisma: {
    $queryRaw: db.queryRaw,
  },
}));

const discarded = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock(import("@/src/services/capture/channel/channel-post-archive"), () => ({ listDiscardedChannelPosts: discarded.list }));

const activity = vi.hoisted(() => ({ read: vi.fn(), latency: vi.fn() }));
vi.mock(import("@/src/services/capture/channel/channel-activity"), () => ({ readChannelActivity: activity.read, readCaptureLatency: activity.latency }));

const { getChannelHealth } = await import("@/src/services/painel/operacoes/channels");

describe("getChannelHealth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    discarded.list.mockResolvedValue(new Map([["200", { total: 1, recent: [] }]]));
    activity.read.mockResolvedValue(new Map([["100", { lastUpdateAt: new Date("2026-07-18T11:00:00.000Z"), silence: { state: "aprendendo", lastPostAt: null } }]]));
    activity.latency.mockResolvedValue(new Map([["telegram-channel:100", { samples: 3, p50Min: 1, p95Min: 4 }]]));
  });

  it("agrega consultas compartilhadas e preserva métricas por canal", async () => {
    const resolvedAt = new Date("2026-07-18T10:00:00.000Z");
    db.queryRaw
      .mockResolvedValueOnce([
        { source: "telegram-channel:100", captures: 5, latest: resolvedAt },
        { source: "telegram-channel:200", captures: 2, latest: resolvedAt },
      ])
      // Já POR POST: a consulta resolve `resource, "resourceId"` antes de contar,
      // então o retry que reprocessa o mesmo post não vira segunda perda.
      .mockResolvedValueOnce([
        { resource: "100", capturado: true, motivo: null, count: 5 },
        { resource: "200", capturado: true, motivo: null, count: 1 },
        { resource: "200", capturado: false, motivo: "mercado_total_ambiguo", count: 2 },
        { resource: "200", capturado: false, motivo: "not_bet", count: 1 },
      ])
      .mockResolvedValueOnce([
        { source: "telegram-channel:100", matched: 3, manual: 1, pending: 0, unmatched: 0, unsupported: 0, total: 4 },
        { source: "telegram-channel:200", matched: 0, manual: 0, pending: 1, unmatched: 1, unsupported: 0, total: 2 },
      ])
      .mockResolvedValueOnce([
        { source: "telegram-channel:100", sharpReason: "sem_linha_atual", closingReason: null, clvReliable: null, frozen: false, count: 1 },
        // CLV confiável congelado: o motivo velho da identidade não é falta.
        { source: "telegram-channel:100", sharpReason: "no_prices", closingReason: null, clvReliable: true, frozen: true, count: 4 },
        // O motivo do fechamento vence o da identidade, e grupos iguais somam.
        { source: "telegram-channel:100", sharpReason: "no_prices", closingReason: "kickoff_sem_captura", clvReliable: false, frozen: true, count: 2 },
        { source: "telegram-channel:100", sharpReason: null, closingReason: "kickoff_sem_captura", clvReliable: false, frozen: true, count: 1 },
        // Não se aplica (entrada ao vivo, segmento desligado): não é falta de
        // odds e não pode tomar vaga do top-3 antes de sair da lista.
        { source: "telegram-channel:100", sharpReason: null, closingReason: "aposta_ao_vivo", clvReliable: false, frozen: true, count: 9 },
        { source: "telegram-channel:100", sharpReason: "sharp_off", closingReason: null, clvReliable: null, frozen: false, count: 7 },
      ])
      .mockResolvedValueOnce([
        { source: "telegram-channel:100", samples: 4, p50: 2, p95: 7 },
      ])
      .mockResolvedValueOnce([
        {
          source: "telegram-channel:100",
          transientFailures: 1,
          preKickoffFailures: 0,
        },
        {
          source: "telegram-channel:200",
          transientFailures: 2,
          preKickoffFailures: 1,
        },
      ]);

    const result = await getChannelHealth([
      { nome: "Canal A", slug: "canal-a", sharpMode: "CLV_ONLY", telegramChannelId: 100n, capturePausedAt: null },
      { nome: "Canal B", slug: "canal-b", sharpMode: "NONE", telegramChannelId: 200n, capturePausedAt: new Date("2026-07-17T12:00:00.000Z") },
    ], new Date("2026-07-18T12:00:00.000Z"));

    expect(db.queryRaw).toHaveBeenCalledTimes(6);
    expect(result.map((channel) => channel.capturePaused)).toEqual([false, true]);
    expect(result[0]).toMatchObject({
      capturas: 5,
      parse: { posts: 5, ok: 5, descartadas: 0, tentativas: 5, falhas: 0, taxaOk: 100, perdas: [] },
      identity: { resolved: 4, pending: 1, failed: 0, total: 5, taxaOk: 100 },
      odds: { faltas: [{ reason: "kickoff_sem_captura", n: 3 }, { reason: "sem_linha_atual", n: 1 }] },
      resolution: { samples: 4, p50Min: 2, p95Min: 7 },
      transientFailures: 1,
      preKickoffFailures: 0,
      transientBatchLimit: 100,
      activity: { lastUpdateAt: new Date("2026-07-18T11:00:00.000Z") },
      latency: { samples: 3, p50Min: 1, p95Min: 4 },
    });
    expect(activity.read).toHaveBeenCalledWith([100n, 200n], expect.any(Date));
    expect(result[1]).toMatchObject({ activity: { lastUpdateAt: null, silence: { state: "aprendendo" } }, latency: { samples: 0 } });
    expect(result[1]).toMatchObject({
      // `guard_rejected` CONTA como falha e `not_bet` NÃO conta: 1 de 3
      // tentativas, e não 1 de 1.
      parse: {
        posts: 4,
        ok: 1,
        descartadas: 1,
        tentativas: 3,
        falhas: 2,
        perdas: [
          { motivo: "mercado_total_ambiguo", classe: "legenda_incompleta", n: 2 },
          { motivo: "not_bet", classe: "descarte_correto", n: 1 },
        ],
      },
      identity: { resolved: 0, pending: 1, failed: 1, total: 2, taxaOk: 0 },
      odds: { faltas: [] },
      transientFailures: 2,
      preKickoffFailures: 1,
      transientBatchLimit: 100,
      discarded: { total: 1, recent: [] },
    });
    expect(result[0]!.discarded).toEqual({ total: 0, recent: [] });
    // `registered / (registered + unparseable)` daria 100% aqui, porque nenhuma
    // das 3 recusas é `unparseable`.
    expect(result[1]!.parse.taxaOk!).toBeCloseTo((1 / 3) * 100, 6);
  });

  it("não consulta o banco sem canais configurados", async () => {
    await expect(getChannelHealth([], new Date())).resolves.toEqual([]);
    expect(db.queryRaw).not.toHaveBeenCalled();
  });
});
