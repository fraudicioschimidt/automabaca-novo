import { safeRemoveTreeSync } from "@/scripts/lib/safe-fs.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as Instance from "@/src/infra/worker-instance";
import { readWorkerInstance } from "@/src/infra/worker-instance";

const mocks = vi.hoisted(() => ({ file: "", bot: vi.fn(), heartbeat: vi.fn(), send: vi.fn(), ready: vi.fn(), cleanup: vi.fn(), exit: vi.fn(), alert: vi.fn(), selfWatch: vi.fn(), selfWatchStop: vi.fn(), recordRelease: vi.fn(), roleCheck: vi.fn(), lock: vi.fn() }));
vi.mock("@/src/infra/worker-instance", async original => {
  const actual = await original<typeof Instance>();
  return { ...actual, beginWorkerInstance: () => { const instance = actual.beginWorkerInstance(mocks.file); return { ...instance, ready: () => { mocks.ready(); instance.ready(); } }; } };
});
vi.mock("@/src/infra/boss", () => ({ createBoss: () => ({ start: async () => {}, send: mocks.send, getSchedules: async () => [] }) }));
vi.mock("@/src/infra/prisma", () => ({ disconnectPrisma: async () => {}, pgPool: {} }));
vi.mock("@/src/infra/runtime-db-role", () => ({ assertRuntimeConnectionIsUnprivileged: mocks.roleCheck }));
vi.mock("@/src/infra/worker-singleton", () => ({ acquireWorkerSingletonLock: mocks.lock }));
vi.mock("@/src/services/ops/alerts", () => ({ sendOperationalAlert: mocks.alert }));
vi.mock("@/src/services/ops/release-verdict", () => ({ recordReleaseReady: mocks.recordRelease }));
vi.mock("@/src/jobs/queues", () => ({ tunePgBossCronDispatchRetention: async () => {} }));
vi.mock(import("@/src/telegram/bot"), () => ({ startTelegramBot: mocks.bot }));
vi.mock("@/src/jobs/worker-heartbeat", () => ({ startWorkerHeartbeat: mocks.heartbeat }));
vi.mock("@/src/jobs/worker-self-watch", () => ({ startWorkerSelfWatch: mocks.selfWatch }));
vi.mock("@/src/jobs/worker-lifecycle", () => ({ shutdownWorkerResources: mocks.cleanup, WORKER_SHUTDOWN_BUDGET_MS: 1000 }));
vi.mock("@/src/jobs/schedules", () => ({
  installScheduleManifest: async () => {}, verifyScheduleManifest: async () => {},
  readLastCronPass: async () => null, reportMissedScheduleTicks: () => [],
}));
vi.mock("@/src/jobs/worker-jobs", () => ({ registerWorkerJobs: async () => {} }));
vi.mock("@/src/infra/llm/gemini", () => ({ geminiConfigured: () => false }));
vi.mock("@/src/infra/llm/groq", () => ({ groqConfigured: () => false }));
vi.mock("@/src/infra/llm/mistral", () => ({ mistralConfigured: () => false }));
let directory: string;
const PROCESS_EVENTS = ["SIGTERM", "SIGINT", "uncaughtException", "unhandledRejection"] as const;
type Signal = (typeof PROCESS_EVENTS)[number];
let listeners: Map<Signal, Set<unknown>>;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  directory = mkdtempSync(path.join(tmpdir(), "automabaca-c57-boot-")); mocks.file = path.join(directory, "marker.json");
  listeners = new Map(PROCESS_EVENTS.map(signal => [signal, new Set(process.listeners(signal))]));
  vi.spyOn(process, "exit").mockImplementation(mocks.exit as never);
  mocks.send.mockResolvedValue("job"); mocks.heartbeat.mockResolvedValue(undefined); mocks.cleanup.mockResolvedValue(undefined); mocks.alert.mockResolvedValue(undefined);
  mocks.selfWatchStop.mockResolvedValue(undefined); mocks.selfWatch.mockReturnValue({ tick: vi.fn(), stop: mocks.selfWatchStop });
  mocks.recordRelease.mockResolvedValue("recorded");
  mocks.roleCheck.mockResolvedValue(undefined); mocks.lock.mockResolvedValue(async () => {});
});
afterEach(() => {
  for (const [signal, previous] of listeners) for (const listener of process.listeners(signal)) if (!previous.has(listener)) process.removeListener(signal, listener as never);
  vi.restoreAllMocks(); safeRemoveTreeSync(tmpdir(), directory);
});
async function boot() { await import("@/src/jobs/worker"); await vi.waitFor(() => expect(mocks.bot).toHaveBeenCalled()); }
function emit(event: Signal, payload: unknown) {
  const handler = process.listeners(event as "SIGTERM").find(listener => !listeners.get(event)?.has(listener));
  if (!handler) throw new Error("sem handler"); (handler as (value: unknown) => void)(payload);
}
const signal = () => emit("SIGTERM", "SIGTERM");

it("não consome heartbeat enquanto inicialização do bot está incompleta", async () => {
  let complete: (() => void) | undefined;
  mocks.bot.mockImplementation(() => new Promise(resolve => { complete = () => resolve(null); }));
  await boot();
  expect(readWorkerInstance(mocks.file)?.readyAt).toBeNull();
  expect(mocks.heartbeat).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  complete?.();
  await vi.waitFor(() => expect(mocks.send).toHaveBeenCalled());
  expect(readWorkerInstance(mocks.file)?.readyAt).toEqual(expect.any(String));
  expect(mocks.ready.mock.invocationCallOrder[0]).toBeLessThan(mocks.heartbeat.mock.invocationCallOrder[0] ?? 0);
});

it("role de banco privilegiada derruba o boot antes do lock, do pg-boss e do bot", async () => {
  mocks.roleCheck.mockRejectedValue(new Error("DATABASE_URL em produção conectou como role privilegiada"));
  await import("@/src/jobs/worker");
  await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledWith(1));
  expect(mocks.lock).not.toHaveBeenCalled(); expect(mocks.bot).not.toHaveBeenCalled();
  expect(mocks.alert).toHaveBeenCalledOnce();
  expect(readWorkerInstance(mocks.file)).toBeNull();
});

it("falha de boot invalida marcador e não publica saúde", async () => {
  mocks.bot.mockRejectedValue(new Error("falha sintética"));
  await boot(); await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledWith(1));
  expect(readWorkerInstance(mocks.file)).toBeNull(); expect(mocks.heartbeat).not.toHaveBeenCalled();
  expect(mocks.alert).toHaveBeenCalledOnce();
});

it("falha de boot para o pg-boss antes de sair: os jobs em voo não ficam presos em active", async () => {
  mocks.bot.mockRejectedValue(new Error("getMe sem rede"));
  await boot(); await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledWith(1));
  expect(mocks.cleanup).toHaveBeenCalledOnce();
  expect(mocks.cleanup.mock.invocationCallOrder[0]).toBeLessThan(mocks.exit.mock.invocationCallOrder[0] ?? 0);
});

it("sinal no meio do boot não vira falha de boot nem corta o drain", async () => {
  let failBot: ((err: Error) => void) | undefined;
  mocks.bot.mockImplementation(() => new Promise((_, reject) => { failBot = reject; }));
  let finishDrain: (() => void) | undefined;
  mocks.cleanup.mockImplementation(() => new Promise<void>(resolve => { finishDrain = resolve; }));
  await boot(); signal();
  // O pg-boss já parado recusa o próximo `boss.work` do boot.
  failBot?.(new Error("Workers are disabled. pg-boss is stopped"));
  await new Promise(resolve => setImmediate(resolve));
  expect(mocks.alert).not.toHaveBeenCalled(); expect(mocks.exit).not.toHaveBeenCalled();
  finishDrain?.();
  await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledWith(0));
  expect(mocks.exit).toHaveBeenCalledOnce();
});

it("shutdown durante boot impede que uma conclusão atrasada reative saúde", async () => {
  let complete: (() => void) | undefined;
  mocks.bot.mockImplementation(() => new Promise(resolve => { complete = () => resolve(null); }));
  await boot(); signal();
  expect(readWorkerInstance(mocks.file)).toBeNull();
  await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledWith(0));
  complete?.(); await new Promise(resolve => setImmediate(resolve));
  expect(mocks.ready).not.toHaveBeenCalled(); expect(mocks.heartbeat).not.toHaveBeenCalled();
});

it("shutdown de worker pronto invalida saúde antes de drenar recursos", async () => {
  mocks.bot.mockResolvedValue(null); await boot(); await vi.waitFor(() => expect(mocks.send).toHaveBeenCalled());
  mocks.cleanup.mockImplementation(async () => { expect(readWorkerInstance(mocks.file)).toBeNull(); });
  signal(); await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledWith(0));
});

it("worker pronto liga a vigia da prova de vida, e ela sem prova drena e sai com 1", async () => {
  mocks.bot.mockResolvedValue(null); await boot();
  await vi.waitFor(() => expect(mocks.selfWatch).toHaveBeenCalledOnce());
  expect(mocks.send.mock.invocationCallOrder[0]).toBeLessThan(mocks.selfWatch.mock.invocationCallOrder[0] ?? 0);
  const [, options] = mocks.selfWatch.mock.calls[0] as [unknown, { onStale: () => void }];
  options.onStale();
  await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledWith(1));
  expect(mocks.selfWatchStop).toHaveBeenCalledOnce();
  expect(mocks.cleanup.mock.invocationCallOrder[0]).toBeLessThan(mocks.exit.mock.invocationCallOrder[0] ?? 0);
});

it("sinal no meio do boot não liga a vigia nem registra a release", async () => {
  let complete: (() => void) | undefined;
  mocks.bot.mockImplementation(() => new Promise(resolve => { complete = () => resolve(null); }));
  await boot(); signal();
  complete?.();
  await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledWith(0));
  expect(mocks.selfWatch).not.toHaveBeenCalled(); expect(mocks.recordRelease).not.toHaveBeenCalled();
});

it("registra a release só depois de pronta, e falha no registro não derruba o worker", async () => {
  mocks.bot.mockResolvedValue(null);
  mocks.recordRelease.mockRejectedValue(new Error("banco fora"));
  await boot(); await vi.waitFor(() => expect(mocks.recordRelease).toHaveBeenCalledOnce());
  expect(mocks.recordRelease).toHaveBeenCalledWith({ bootedAt: expect.any(Date) });
  expect(mocks.ready.mock.invocationCallOrder[0]).toBeLessThan(mocks.recordRelease.mock.invocationCallOrder[0] ?? 0);
  expect(mocks.selfWatch.mock.invocationCallOrder[0]).toBeLessThan(mocks.recordRelease.mock.invocationCallOrder[0] ?? 0);
  await new Promise(resolve => setImmediate(resolve));
  expect(readWorkerInstance(mocks.file)?.readyAt).toEqual(expect.any(String));
  expect(mocks.alert).not.toHaveBeenCalled(); expect(mocks.exit).not.toHaveBeenCalled();
});

it.each([
  ["uncaughtException", new Error("exceção fora de promessa")],
  ["unhandledRejection", new Error("promessa sem catch")],
] as const)("%s drena o pg-boss antes de sair com 1: os jobs em voo não ficam presos em active", async (event, error) => {
  mocks.bot.mockResolvedValue(null); await boot(); await vi.waitFor(() => expect(mocks.send).toHaveBeenCalled());
  emit(event, error);
  await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledWith(1));
  expect(readWorkerInstance(mocks.file)).toBeNull();
  expect(mocks.cleanup).toHaveBeenCalledOnce();
  expect(mocks.cleanup.mock.invocationCallOrder[0]).toBeLessThan(mocks.exit.mock.invocationCallOrder[0] ?? 0);
});
