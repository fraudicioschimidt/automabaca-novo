import { describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";

const mocks = vi.hoisted(() => ({ alert: vi.fn(), warn: vi.fn() }));
vi.mock("@/src/services/ops/alerts", () => ({ sendOperationalAlert: mocks.alert }));
vi.mock("@/src/infra/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: vi.fn(), fatal: vi.fn() }),
}));

import { cronFiringMinutes } from "@/src/domain/cron-cadence";
import { JOB_RETENTION_SECONDS } from "@/src/jobs/queues";
import {
  installScheduleManifest,
  reportMissedScheduleTicks,
  SCHEDULE_MANIFEST,
  verifyScheduleManifest,
} from "@/src/jobs/schedules";

const [first, second] = SCHEDULE_MANIFEST;
if (!first || !second) throw new Error("manifesto sem agendamentos suficientes para o teste");

describe("manifesto de schedules", () => {
  function runtimeDoManifesto() {
    return SCHEDULE_MANIFEST.map((item) => ({
      name: item.queue,
      key: "",
      cron: item.cron,
      timezone: item.timezone,
      options: { missed: item.missed },
    }));
  }

  it("tem filas únicas e instala cron, timezone e retenção declarados", async () => {
    expect(new Set(SCHEDULE_MANIFEST.map((item) => item.queue)).size).toBe(SCHEDULE_MANIFEST.length);
    const schedule = vi.fn().mockResolvedValue(undefined);
    const getSchedules = vi.fn().mockResolvedValue([]);
    const unschedule = vi.fn();
    await installScheduleManifest({ schedule, getSchedules, unschedule } as unknown as PgBoss);
    expect(schedule).toHaveBeenCalledTimes(SCHEDULE_MANIFEST.length);
    expect(unschedule).not.toHaveBeenCalled();
    for (const item of SCHEDULE_MANIFEST) {
      expect(schedule).toHaveBeenCalledWith(item.queue, item.cron, null, {
        tz: "Etc/GMT+3",
        deleteAfterSeconds: item.deleteAfterSeconds,
        missed: item.maxGapMinutes >= 30 ? "once" : "skip",
      });
    }
  });

  it("recupera o disparo perdido dos crons de 30 min ou mais, e só deles", () => {
    const politica = Object.fromEntries(SCHEDULE_MANIFEST.map((item) => [item.queue, item.missed]));
    for (const fila of ["settlement.ia_judge", "policy.evaluate", "executive.briefing", "health.digest",
      "pending.digest", "audit.purge", "channels.weekly_digest", "teams.catalog_pairing"]) {
      expect(politica[fila], fila).toBe("once");
    }
    for (const fila of ["outbox.dispatch", "closing.sync", "sharp.revive", "observability.slo",
      "settlement.flashscore_results", "sharp.bridge_postgame"]) {
      expect(politica[fila], fila).toBe("skip");
    }
  });

  it("o boot recusa agendamento gravado sem a recuperação do disparo perdido", async () => {
    const semRecuperacao = runtimeDoManifesto().map((item) => ({ ...item, options: {} }));
    await expect(verifyScheduleManifest({ getSchedules: vi.fn().mockResolvedValue(semRecuperacao) } as unknown as PgBoss))
      .rejects.toThrow(/settlement\.ia_judge: missed skip != once/);
  });

  it("guarda um dia do cron frequente, dois dos demais e duas semanas do semanal", () => {
    const retencao = Object.fromEntries(SCHEDULE_MANIFEST.map((item) => [item.queue, item.deleteAfterSeconds]));
    expect(retencao["outbox.dispatch"]).toBe(86_400);
    expect(retencao["closing.price_series_sweep"]).toBe(86_400);
    expect(retencao["health.heartbeat"]).toBe(86_400);
    expect(retencao["observability.slo"]).toBe(JOB_RETENTION_SECONDS);
    expect(retencao["audit.purge"]).toBe(JOB_RETENTION_SECONDS);
    // A última conclusão do semanal tem de estar na tabela quando o vigia de
    // "parou de rodar" a procura, uma semana e uma hora depois.
    expect(retencao["channels.weekly_digest"]).toBe(14 * 86_400);
  });

  it("os crons de 5 a 20 min não se acumulam no mesmo minuto", () => {
    // Alinhados, disputariam o pool do banco no mesmo segundo.
    const frequentes = SCHEDULE_MANIFEST.filter((item) => item.maxGapMinutes > 1 && item.maxGapMinutes <= 20);
    const minutosDe = (cron: string) => new Set(cronFiringMinutes(cron).filter((minuto) => minuto < 60));
    for (let minuto = 0; minuto < 60; minuto += 1) {
      const noMinuto = frequentes.filter((item) => minutosDe(item.cron).has(minuto));
      const deCincoEmCinco = noMinuto.filter((item) => item.maxGapMinutes === 5);
      expect(deCincoEmCinco.length, `minuto ${minuto}`).toBeLessThanOrEqual(1);
      expect(noMinuto.length, `minuto ${minuto}: ${noMinuto.map((item) => item.queue).join(", ")}`).toBeLessThanOrEqual(2);
    }
    // Cada família de minuto (resto por 5) tem no máximo o cron de 5 em 5 e mais um.
    for (let familia = 0; familia < 5; familia += 1) {
      const naFamilia = frequentes.filter((item) => [...minutosDe(item.cron)].some((minuto) => minuto % 5 === familia));
      expect(naFamilia.length, `família ${familia}: ${naFamilia.map((item) => item.queue).join(", ")}`).toBeLessThanOrEqual(2);
    }
  });

  it("aceita o runtime idêntico ao manifesto", async () => {
    const getSchedules = vi.fn().mockResolvedValue(runtimeDoManifesto());
    await expect(verifyScheduleManifest({ getSchedules } as unknown as PgBoss)).resolves.toBeUndefined();
  });

  it("falha alto quando um schedule está ausente ou divergente", async () => {
    const rest = SCHEDULE_MANIFEST.slice(1);
    const getSchedules = vi.fn().mockResolvedValue(rest.map((item, index) => ({
      name: item.queue,
      key: "",
      cron: index === 0 ? "0 0 * * *" : item.cron,
      timezone: item.timezone,
    })));
    await expect(verifyScheduleManifest({ getSchedules } as unknown as PgBoss)).rejects.toThrow(
      new RegExp(`${first.queue}: ausente.*${second.queue}: cron`),
    );
  });

  it("o boot desagenda o que saiu do manifesto e só isso", async () => {
    mocks.alert.mockClear();
    const schedule = vi.fn().mockResolvedValue(undefined);
    const unschedule = vi.fn().mockResolvedValue(undefined);
    const getSchedules = vi.fn().mockResolvedValue([
      ...runtimeDoManifesto(),
      { name: "settlement.web_settle", key: "", cron: "*/30 * * * *", timezone: "UTC" },
      { name: first.queue, key: "extra", cron: "0 0 * * *", timezone: "UTC" },
    ]);

    await installScheduleManifest({ schedule, getSchedules, unschedule } as unknown as PgBoss);

    expect(unschedule.mock.calls).toEqual([
      ["settlement.web_settle", ""],
      [first.queue, "extra"],
    ]);
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it("falha ao desagendar ALERTA e deixa o worker subir", async () => {
    // Um agendamento a mais só acumula job sem consumidor; derrubar o boot por
    // isso pararia settlement, closing e captura.
    mocks.alert.mockClear().mockResolvedValue(undefined);
    const schedule = vi.fn().mockResolvedValue(undefined);
    const unschedule = vi.fn().mockRejectedValue(new Error("conexão caiu"));
    const getSchedules = vi.fn().mockResolvedValue([
      ...runtimeDoManifesto(),
      { name: "settlement.web_settle", key: "", cron: "*/30 * * * *", timezone: "UTC" },
    ]);

    await expect(
      installScheduleManifest({ schedule, getSchedules, unschedule } as unknown as PgBoss),
    ).resolves.toBeUndefined();

    expect(mocks.alert).toHaveBeenCalledWith(
      expect.stringContaining("settlement.web_settle"),
      expect.objectContaining({
        source: "jobs.schedule-manifest",
        autoResolve: false,
      }),
    );
  });

  it("órfão não mascara divergência — ausente continua derrubando o boot", async () => {
    mocks.alert.mockClear().mockResolvedValue(undefined);
    const getSchedules = vi.fn().mockResolvedValue([
      ...SCHEDULE_MANIFEST.slice(1).map((item) => ({
        name: item.queue,
        key: "",
        cron: item.cron,
        timezone: item.timezone,
      })),
      { name: "fila.zumbi", key: "", cron: "*/30 * * * *", timezone: "UTC" },
    ]);

    await expect(
      verifyScheduleManifest({ getSchedules } as unknown as PgBoss),
    ).rejects.toThrow(new RegExp(`${first.queue}: ausente`));
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  describe("disparo que caiu no reinício do worker", () => {
    const manifesto = [
      { queue: "settlement.ia_judge", cron: "15 1-23/2 * * *", maxGapMinutes: 120 },
      { queue: "closing.sync", cron: "*/5 * * * *", maxGapMinutes: 5 },
    ];
    const gravados = [{ name: "settlement.ia_judge", key: "", options: { missed: "once" as const } }];

    it("registra o disparo de cron longo que ficou entre o último ciclo e o boot", () => {
      mocks.warn.mockClear();
      // 19:15 em São Paulo = 22:15 UTC. O último ciclo foi às 22:14:50 e o boot, às 22:17.
      const perdidos = reportMissedScheduleTicks({
        lastCronPass: new Date("2026-09-23T22:14:50Z"), bootedAt: new Date("2026-09-23T22:17:00Z"),
        storedSchedules: gravados, manifest: manifesto,
      });
      expect(perdidos).toEqual([{ queue: "settlement.ia_judge", tick: new Date("2026-09-23T22:15:00Z"), recovered: true }]);
      expect(mocks.warn).toHaveBeenCalledWith(
        expect.objectContaining({ eventCode: "SCHEDULE_TICK_MISSED", queue: "settlement.ia_judge", recovered: true }),
        expect.any(String),
      );
    });

    it("o disparo ainda na janela do primeiro ciclo fica com o pg-boss, e o cron curto nunca entra", () => {
      mocks.warn.mockClear();
      // Boot 40 s depois do disparo: o primeiro ciclo ainda o cria sozinho.
      expect(reportMissedScheduleTicks({
        lastCronPass: new Date("2026-09-23T22:14:50Z"), bootedAt: new Date("2026-09-23T22:15:40Z"),
        storedSchedules: gravados, manifest: manifesto,
      })).toEqual([]);
      expect(reportMissedScheduleTicks({
        lastCronPass: null, bootedAt: new Date("2026-09-23T22:17:00Z"), storedSchedules: gravados, manifest: manifesto,
      })).toEqual([]);
      expect(mocks.warn).not.toHaveBeenCalled();
    });
  });
});
