import type { PgBoss, Schedule } from "pg-boss";
import { createLogger } from "@/src/infra/logger";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { prisma } from "@/src/infra/prisma";
import type { QueueName } from "@/src/infra/queue-contract";
import { cronMaxGapMinutes, latestCronFiring } from "@/src/domain/cron-cadence";
import { SAO_PAULO_UTC_OFFSET_HOURS } from "@/src/domain/dates";
import { scheduledJobRetentionSeconds } from "@/src/jobs/queues";
import { WORKER_JOBS } from "@/src/jobs/worker-jobs";
import { sendOperationalAlert } from "@/src/services/ops/alerts";

const log = createLogger("schedules");

/** A opção `missed` do `schedule()` do pg-boss: o que fazer com o disparo que caiu num buraco sem ciclo do cron. */
type ScheduleMissedPolicy = "skip" | "once";

type ScheduleDefinition = {
  queue: QueueName;
  cron: string;
  timezone: typeof SCHEDULE_TIMEZONE;
  purpose: string;
  /** Maior intervalo entre dois disparos: quanto tempo sem rodar ainda é normal. */
  maxGapMinutes: number;
  deleteAfterSeconds: number;
  /** O que o pg-boss faz com o disparo que caiu num buraco sem ciclo do cron. */
  missed: ScheduleMissedPolicy;
};

/**
 * Os crons são escritos no relógio do dono, UTC−3 fixo: o mesmo offset que o
 * resto do código usa para São Paulo (`src/domain/dates.ts`), e por isso o
 * "07:10" de um comentário é o "10 7" do cron. `Etc/GMT+3` é esse offset fixo
 * no nome IANA (o sinal é invertido por convenção): sem horário de verão, um
 * disparo nunca some nem se repete na virada do relógio.
 */
export const SCHEDULE_TIMEZONE = "Etc/GMT+3";

/**
 * O pg-boss só cria o job de um disparo num ciclo do cron (a cada 30 s) até
 * 60 s depois dele, e o reinício do worker numa publicação (drenagem mais boot)
 * deixa um buraco maior que isso: o disparo que cai ali some. Com
 * `missed: "once"`, o primeiro ciclo depois do buraco cria UM job do disparo
 * mais recente que ficou nele, numa vaga própria daquele disparo, e o ciclo
 * seguinte já não o vê: nunca roda em dobro. Vale para os crons de 30 min ou
 * mais; nos de 1 a 20 min o disparo seguinte cobre.
 */
export const SCHEDULE_CATCH_UP_MIN_GAP_MINUTES = 30;
/** Janela em que o ciclo do cron do pg-boss ainda cria o job de um disparo. */
const PGBOSS_CRON_DUE_WINDOW_MS = 60_000;

export function missedPolicyFor(maxGapMinutes: number): ScheduleMissedPolicy {
  return maxGapMinutes >= SCHEDULE_CATCH_UP_MIN_GAP_MINUTES ? "once" : "skip";
}

/** Os agendamentos declarados em `WORKER_JOBS`. */
export const SCHEDULE_MANIFEST: readonly ScheduleDefinition[] = WORKER_JOBS.flatMap((job) =>
  job.schedule
    ? [{
      queue: job.queue,
      cron: job.schedule.cron,
      timezone: SCHEDULE_TIMEZONE,
      purpose: job.schedule.purpose,
      maxGapMinutes: cronMaxGapMinutes(job.schedule.cron),
      deleteAfterSeconds: scheduledJobRetentionSeconds(job.schedule.cron),
      missed: missedPolicyFor(cronMaxGapMinutes(job.schedule.cron)),
    }]
    : [],
);

export function scheduleOptionsOf(item: Pick<ScheduleDefinition, "timezone" | "deleteAfterSeconds" | "missed">) {
  return { tz: item.timezone, deleteAfterSeconds: item.deleteAfterSeconds, missed: item.missed };
}

export async function installScheduleManifest(boss: PgBoss): Promise<void> {
  for (const item of SCHEDULE_MANIFEST) {
    // `schedule` é upsert: trocar cron, fuso ou retenção no manifesto vale no
    // boot seguinte, e `verifyScheduleManifest` confere o que ficou gravado.
    await boss.schedule(item.queue, item.cron, null, scheduleOptionsOf(item));
  }
  await removeSchedulesOutsideManifest(boss);
}

/**
 * O manifesto é a fonte da verdade dos agendamentos. O pg-boss guarda cada
 * `schedule` no banco, então tirar uma fila do manifesto não a desagenda: ela
 * continuaria disparando sem consumidor e os jobs se acumulariam em `created`.
 * No boot, tudo o que está em `pgboss.schedule` e não no manifesto sai.
 *
 * Falha ao remover não derruba o boot: um agendamento a mais só acumula job
 * sem consumidor, e parar o worker por isso para settlement, closing e
 * captura. Vira alerta para alguém remover à mão.
 */
async function removeSchedulesOutsideManifest(boss: PgBoss): Promise<void> {
  const esperadas = new Set<string>(SCHEDULE_MANIFEST.map((item) => item.queue));
  const orfaos = (await boss.getSchedules())
    .filter((item) => item.key !== "" || !esperadas.has(item.name));
  const falhas: string[] = [];
  for (const item of orfaos) {
    try {
      await boss.unschedule(item.name, item.key);
      log.warn({ queue: item.name, key: item.key, cron: item.cron }, "schedule fora do manifesto removido");
    } catch (err) {
      falhas.push(item.name);
      log.error({ err, queue: item.name, key: item.key }, "falha ao remover schedule fora do manifesto");
    }
  }
  if (falhas.length > 0) {
    await sendOperationalAlert(
      `🗓️ Agendamentos sem dono: ${falhas.join(", ")}\n` +
        "Saíram do manifesto, mas o boot não conseguiu desagendá-los, e as tarefas se acumulam na fila.\n" +
        "👉 Remova-os de pgboss.schedule.",
      {
        source: "jobs.schedule-manifest",
        key: falhas.slice().sort().join(","),
        title: "Schedule agendado sem consumidor",
        resource: "pgboss-schedule",
        evidence: { orfaos: falhas },
        autoResolve: false,
      },
    );
  }
}

export async function verifyScheduleManifest(boss: PgBoss): Promise<void> {
  const registered = await boss.getSchedules();
  const errors: string[] = [];
  for (const expected of SCHEDULE_MANIFEST) {
    const actual = registered.find((item) => item.name === expected.queue && item.key === "");
    if (!actual) {
      errors.push(`${expected.queue}: ausente`);
      continue;
    }
    if (actual.cron !== expected.cron) {
      errors.push(`${expected.queue}: cron ${actual.cron} != ${expected.cron}`);
    }
    if (actual.timezone !== expected.timezone) {
      errors.push(`${expected.queue}: timezone ${actual.timezone} != ${expected.timezone}`);
    }
    const missed = actual.options?.missed ?? "skip";
    if (missed !== expected.missed) {
      errors.push(`${expected.queue}: missed ${missed} != ${expected.missed}`);
    }
  }
  // Ausente ou com cron, fuso ou recuperação divergente derruba o boot: o
  // worker NÃO faria o trabalho agendado, e subir assim é operar às cegas.
  if (errors.length > 0) {
    throw new Error(`Manifesto de schedules divergente: ${errors.join("; ")}`);
  }
}

/**
 * Quando o ciclo do cron rodou pela última vez, antes do boot: o que o
 * processo anterior deixou em `pgboss.version.cron_on`. `null` em banco sem
 * pg-boss instalado ou sem ciclo algum.
 */
export async function readLastCronPass(): Promise<Date | null> {
  try {
    const rows = await prisma.$queryRaw<Array<{ cronOn: Date | null }>>`
      SELECT cron_on AS "cronOn" FROM pgboss.version LIMIT 1
    `;
    return rows[0]?.cronOn ?? null;
  } catch {
    // Primeiro boot num banco novo: o schema do pg-boss ainda não existe.
    return null;
  }
}

/**
 * Registra no log os disparos que caíram no buraco entre o último ciclo do
 * cron antes do boot e o primeiro ciclo deste processo. O pg-boss cria o job
 * dos que têm `missed: "once"` no agendamento que estava gravado quando o
 * ciclo rodou (o do boot anterior); os demais ficam só registrados.
 */
export function reportMissedScheduleTicks(params: {
  lastCronPass: Date | null;
  bootedAt: Date;
  storedSchedules: readonly Pick<Schedule, "name" | "key" | "options">[];
  manifest?: readonly { queue: string; cron: string; maxGapMinutes: number }[];
}): Array<{ queue: string; tick: Date; recovered: boolean }> {
  const { lastCronPass, bootedAt, storedSchedules } = params;
  if (!lastCronPass) return [];
  const until = new Date(bootedAt.getTime() - PGBOSS_CRON_DUE_WINDOW_MS);
  const missed = (params.manifest ?? SCHEDULE_MANIFEST).flatMap((item) => {
    if (item.maxGapMinutes < SCHEDULE_CATCH_UP_MIN_GAP_MINUTES) return [];
    const tick = latestCronFiring(item.cron, lastCronPass, until, SAO_PAULO_UTC_OFFSET_HOURS);
    if (!tick) return [];
    const stored = storedSchedules.find((schedule) => schedule.name === item.queue && schedule.key === "");
    return [{ queue: item.queue, tick, recovered: stored?.options?.missed === "once" }];
  });
  for (const item of missed) {
    log.warn(
      {
        eventCode: LOG_EVENTS.SCHEDULE_TICK_MISSED,
        queue: item.queue,
        tick: item.tick.toISOString(),
        lastCronPass: lastCronPass.toISOString(),
        bootedAt: bootedAt.toISOString(),
        recovered: item.recovered,
      },
      item.recovered
        ? "disparo caiu no reinício do worker; o pg-boss cria um job dele no primeiro ciclo"
        : "disparo caiu no reinício do worker e não será recuperado (agendamento gravado sem recuperação)",
    );
  }
  return missed;
}
