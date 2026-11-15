import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgBoss } from "pg-boss";
import { createBoss } from "@/src/infra/boss";
import { prisma } from "@/src/infra/prisma";
import { defaultQueuePolicy } from "@/src/infra/queue-contract";
import { WORKER_JOBS } from "@/src/jobs/worker-jobs";
import {
  installScheduleManifest,
  missedPolicyFor,
  SCHEDULE_MANIFEST,
  SCHEDULE_TIMEZONE,
  scheduleOptionsOf,
  verifyScheduleManifest,
} from "@/src/jobs/schedules";

const FORA_DO_MANIFESTO = "teste.fila_fora_do_manifesto";
/** Cron diário só destes testes, que dispara num minuto escolhido pelo teste. */
const DIARIA = "teste.cron_diario";
/** Cron de todo segundo só destes testes: todo ciclo do cron tem um disparo dele para repassar. */
const CONTROLE = "teste.cron_controle";
/** Agendamento que a produção ainda tem de antes da divisão em `consistency.*`. */
const SUBSTITUIDA = "contas.drift";

let boss: PgBoss;

beforeAll(async () => {
  // Só produtor: sem o poller de cron, os agendamentos instalados aqui não
  // disparam jobs no banco de teste.
  boss = createBoss({ producerOnly: true });
  await boss.start();
  for (const item of SCHEDULE_MANIFEST) {
    // Com a policy de produção: a fila fica no banco do worker de teste, e outro
    // arquivo que a registre depois com a policy certa seria recusado no boot.
    const policy = WORKER_JOBS.find((job) => job.queue === item.queue)?.queueOptions.policy ?? defaultQueuePolicy(item.queue);
    await boss.createQueue(item.queue, { policy });
  }
  await boss.createQueue(FORA_DO_MANIFESTO);
  await boss.createQueue(SUBSTITUIDA);
  await boss.createQueue(DIARIA);
  await boss.createQueue(CONTROLE);
});

afterAll(async () => {
  for (const item of await boss.getSchedules()) await boss.unschedule(item.name, item.key);
  await boss.deleteQueue(FORA_DO_MANIFESTO);
  await boss.deleteQueue(SUBSTITUIDA);
  await boss.deleteQueue(DIARIA);
  await boss.deleteQueue(CONTROLE);
  await boss.stop({ graceful: false });
  await prisma.$disconnect();
});

describe("reconciliação do manifesto contra pgboss.schedule (pg-boss real)", () => {
  it("o boot desagenda a fila que saiu do manifesto e mantém as do manifesto", async () => {
    await boss.schedule(FORA_DO_MANIFESTO, "*/30 * * * *", null, { tz: "UTC" });
    await boss.schedule(SUBSTITUIDA, "40 6 * * *", null, { tz: "UTC" });

    await installScheduleManifest(boss);

    const nomes = (await boss.getSchedules()).map((item) => item.name).sort();
    expect(nomes).toEqual(SCHEDULE_MANIFEST.map((item) => item.queue).sort());
    expect(nomes).not.toContain(SUBSTITUIDA);
    expect(nomes).toEqual(expect.arrayContaining(["consistency.financeiro", "consistency.revisao"]));
    await expect(verifyScheduleManifest(boss)).resolves.toBeUndefined();
  });

  it("o boot troca o agendamento antigo em UTC pelo do manifesto, sem derrubar a verificação", async () => {
    // Agendamento em UTC, com os mesmos disparos, como um banco pode ter.
    await boss.schedule("executive.briefing", "0 2 * * *", null, { tz: "UTC", deleteAfterSeconds: 604_800 });
    await boss.schedule("closing.sync", "*/5 * * * *", null, { tz: "UTC" });
    await expect(verifyScheduleManifest(boss)).rejects.toThrow(/executive\.briefing: cron 0 2/);

    await installScheduleManifest(boss);

    await expect(verifyScheduleManifest(boss)).resolves.toBeUndefined();
    const briefing = (await boss.getSchedules()).find((item) => item.name === "executive.briefing");
    expect(briefing).toMatchObject({ cron: "5 0 * * *", timezone: "Etc/GMT+3" });
  });
});

describe("disparo que cai no reinício do worker (pg-boss real)", () => {
  /** Cron diário no relógio do manifesto (UTC−3) que dispara no minuto de `instante`. */
  function cronDoDisparo(instante: Date): string {
    const local = new Date(instante.getTime() - 3 * 3_600_000);
    return `${local.getUTCMinutes()} ${local.getUTCHours()} * * *`;
  }

  /** O cenário: o disparo foi há 3 min, e o último ciclo do cron antes do reinício foi em `ultimoCiclo`. */
  async function prepararReinicio(disparo: Date, ultimoCiclo: Date): Promise<void> {
    for (const item of await boss.getSchedules()) await boss.unschedule(item.name, item.key);
    await boss.schedule(DIARIA, cronDoDisparo(disparo), null, scheduleOptionsOf({
      timezone: SCHEDULE_TIMEZONE, deleteAfterSeconds: 172_800, missed: missedPolicyFor(1_440),
    }));
    await boss.schedule(CONTROLE, "* * * * * *", null, { tz: "UTC" });
    await prisma.$executeRawUnsafe(`UPDATE pgboss.schedule SET created_on = now() - interval '2 days' WHERE name = $1`, DIARIA);
    await prisma.$executeRawUnsafe(
      `DELETE FROM pgboss.job WHERE name IN ($1, $2) OR (name = '__pgboss__send-it' AND data->>'name' IN ($1, $2))`,
      DIARIA, CONTROLE,
    );
    await prisma.$executeRawUnsafe(`UPDATE pgboss.version SET cron_on = $1::timestamptz`, ultimoCiclo.toISOString());
  }

  const jobsDaFila = async () => Number((await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*) AS n FROM pgboss.job WHERE name = $1`, DIARIA))[0]?.n ?? 0);

  /**
   * Sobe um pg-boss com o ciclo do cron, como o boot do worker, até o primeiro ciclo terminar e o
   * que ele repassou virar job. O `cron_on` não diz isso: ele muda na reivindicação, antes de o
   * ciclo ler os agendamentos. O ciclo repassa todos os disparos num único INSERT e o do CONTROLE
   * está sempre nele: quando esse aparece, o da DIARIA, se o ciclo o devia, veio junto.
   */
  async function bootDoWorker(): Promise<void> {
    const worker = createBoss();
    await worker.start();
    try {
      for (;;) {
        const [estado] = await prisma.$queryRawUnsafe<Array<{ controle: bigint; pendentes: bigint }>>(
          `SELECT count(*) FILTER (WHERE data->>'name' = $2) AS controle,
                  count(*) FILTER (WHERE state < 'completed') AS pendentes
             FROM pgboss.job WHERE name = '__pgboss__send-it' AND data->>'name' IN ($1, $2)`, DIARIA, CONTROLE);
        if (Number(estado?.controle ?? 0) > 0 && Number(estado?.pendentes ?? 0) === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      await worker.stop({ graceful: false });
    }
  }

  it("boot logo depois de um disparo perdido cria UM job dele", async () => {
    const disparo = new Date(Math.floor((Date.now() - 3 * 60_000) / 60_000) * 60_000);
    // O último ciclo foi antes do disparo, e o boot veio mais de 60 s depois dele.
    await prepararReinicio(disparo, new Date(disparo.getTime() - 60_000));

    await bootDoWorker();

    expect(await jobsDaFila()).toBe(1);
  }, 40_000);

  it("boot com o disparo já rodado não cria nada", async () => {
    const disparo = new Date(Math.floor((Date.now() - 3 * 60_000) / 60_000) * 60_000);
    // O último ciclo passou depois do disparo, que rodou.
    await prepararReinicio(disparo, new Date(disparo.getTime() + 20_000));
    const rodado = await boss.send(DIARIA, null);
    const [ativo] = await boss.fetch(DIARIA);
    expect(ativo?.id).toBe(rodado);
    await boss.complete(DIARIA, rodado!);

    await bootDoWorker();

    expect(await jobsDaFila()).toBe(1);
  }, 40_000);
});
