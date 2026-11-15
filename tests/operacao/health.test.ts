import { describe, expect, it } from "vitest";
import {
  PRODUCTION_OUTAGE_ALERT_MS,
  WORKER_HEARTBEAT_STALE_MS,
  WORKER_SELF_RESTART_LIMIT,
  WORKER_SELF_RESTART_STALE_MS,
  nextProductionOutage,
  workerSelfWatchVerdict,
  type ProductionOutage,
} from "@/src/domain/health";

const MIN = 60_000;
const at = (minutes: number) => new Date(Date.UTC(2026, 8, 24, 12, 0) + minutes * MIN);

describe("vigia do próprio worker", () => {
  it("só se reinicia um heartbeat depois de o /api/health já dar o worker como parado", () => {
    expect(WORKER_SELF_RESTART_STALE_MS).toBe(20 * MIN);
    expect(WORKER_SELF_RESTART_STALE_MS).toBeGreaterThan(WORKER_HEARTBEAT_STALE_MS);
  });

  it("com prova recente segue vivo; 20 min depois da última prova, reinicia", () => {
    const base = { readyAt: at(0), lastProofAt: at(30), restartsInWindow: 0 };
    expect(workerSelfWatchVerdict({ ...base, now: at(49) })).toEqual({ kind: "alive" });
    expect(workerSelfWatchVerdict({ ...base, now: at(50) })).toEqual({ kind: "restart", staleSince: at(30) });
  });

  it("sem nenhuma prova desde o boot, conta a partir do boot", () => {
    const base = { readyAt: at(0), lastProofAt: null, restartsInWindow: 0 };
    expect(workerSelfWatchVerdict({ ...base, now: at(19) })).toEqual({ kind: "alive" });
    expect(workerSelfWatchVerdict({ ...base, now: at(20) })).toEqual({ kind: "restart", staleSince: at(0) });
  });

  it("prova anterior ao boot (de outro processo) não adianta a conta", () => {
    expect(workerSelfWatchVerdict({ readyAt: at(0), lastProofAt: at(-30), restartsInWindow: 0, now: at(10) }))
      .toEqual({ kind: "alive" });
  });

  it("com a cota da janela gasta, não reinicia de novo", () => {
    const base = { readyAt: at(0), lastProofAt: null, now: at(25) };
    expect(workerSelfWatchVerdict({ ...base, restartsInWindow: WORKER_SELF_RESTART_LIMIT - 1 }).kind).toBe("restart");
    expect(workerSelfWatchVerdict({ ...base, restartsInWindow: WORKER_SELF_RESTART_LIMIT }))
      .toEqual({ kind: "exhausted", staleSince: at(0) });
  });
});

describe("queda acompanhada pela web", () => {
  const down = { ok: false, db: true };
  const up = { ok: true, db: true };

  it("avisa uma vez só, depois de 20 min fora", () => {
    let outage: ProductionOutage | null = null;
    const effects: Array<string | null> = [];
    for (const minutes of [0, 10, 19, 20, 21, 40]) {
      const step = nextProductionOutage(outage, down, at(minutes));
      outage = step.outage;
      effects.push(step.effect);
    }
    expect(effects).toEqual([null, null, null, "alert", null, null]);
    expect(outage).toEqual({ since: at(0), cause: "worker", alerted: true });
    expect(PRODUCTION_OUTAGE_ALERT_MS).toBe(20 * MIN);
  });

  it("a volta de uma queda avisada encerra com a duração; a de uma queda curta, calada", () => {
    const alerted: ProductionOutage = { since: at(0), cause: "worker", alerted: true };
    expect(nextProductionOutage(alerted, up, at(30))).toEqual({ outage: null, effect: "recovered", ended: alerted });
    const short: ProductionOutage = { since: at(0), cause: "worker", alerted: false };
    expect(nextProductionOutage(short, up, at(5))).toEqual({ outage: null, effect: null });
    expect(nextProductionOutage(null, up, at(5))).toEqual({ outage: null, effect: null });
  });

  it("a causa é a do momento do aviso, e não muda depois dele", () => {
    let step = nextProductionOutage(null, { ok: false, db: false }, at(0));
    expect(step.outage?.cause).toBe("database");
    step = nextProductionOutage(step.outage, down, at(20));
    expect(step).toEqual({ outage: { since: at(0), cause: "worker", alerted: true }, effect: "alert" });
    step = nextProductionOutage(step.outage, { ok: false, db: false }, at(25));
    expect(step.outage?.cause).toBe("worker");
  });

  it("uma sonda boa no meio zera a contagem", () => {
    let step = nextProductionOutage(null, down, at(0));
    step = nextProductionOutage(step.outage, up, at(15));
    step = nextProductionOutage(step.outage, down, at(16));
    step = nextProductionOutage(step.outage, down, at(35));
    expect(step.effect).toBeNull();
    expect(nextProductionOutage(step.outage, down, at(36)).effect).toBe("alert");
  });
});
