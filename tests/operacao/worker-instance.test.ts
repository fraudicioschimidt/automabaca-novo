import { safeRemoveTreeSync } from "@/scripts/lib/safe-fs.mjs";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { beginWorkerInstance, currentWorkerHealthy, readWorkerInstance } from "@/src/infra/worker-instance";

let directory: string; let file: string;
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), "automabaca-c57-instance-")); file = path.join(directory, "marker.json"); });
afterEach(() => { safeRemoveTreeSync(tmpdir(), directory); });
function edit(fields: Record<string, unknown>) {
  const marker = readWorkerInstance(file); if (!marker) throw new Error("sem marcador");
  writeFileSync(`${file}.${marker.instanceId}`, JSON.stringify({ ...marker, ...fields }));
}

it("prontidão e shutdown não reescrevem nem apagam o ponteiro compartilhado", () => {
  const instance = beginWorkerInstance(file); const pointer = readFileSync(file, "utf8");
  instance.ready(); expect(readFileSync(file, "utf8")).toBe(pointer);
  instance.stop(); expect(readFileSync(file, "utf8")).toBe(pointer);
  expect(readWorkerInstance(file)).toBeNull();
});

it("começa sem prova, passa a pronto explicitamente e invalida no shutdown", async () => {
  const query = vi.fn(async () => ({ rows: [{ healthy: true }] }));
  const instance = beginWorkerInstance(file);
  expect(instance.proof()).toBeNull();
  expect(await currentWorkerHealthy(query, file)).toBe(false);
  expect(query).not.toHaveBeenCalled();
  instance.ready();
  expect(await currentWorkerHealthy(query, file)).toBe(true);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file).length).toBeLessThan(512);
  instance.stop();
  expect(instance.proof()).toBeNull();
  expect(await currentWorkerHealthy(query, file)).toBe(false);
  expect(() => instance.ready()).toThrow();
});

it("reinício troca identidade e drain do anterior não apaga o sucessor", () => {
  const old = beginWorkerInstance(file); old.ready(); const oldId = old.proof()?.workerInstance.instanceId;
  const next = beginWorkerInstance(file); old.stop();
  expect(readWorkerInstance(file)).toMatchObject({ readyAt: null });
  next.ready();
  expect(next.proof()?.workerInstance.instanceId).not.toBe(oldId);
  expect(() => old.ready()).toThrow();
});

it.each(["", "{", "null", "{}", "[]", "x".repeat(3000)])("arquivo inválido não usa saúde antiga (%s)", async raw => {
  writeFileSync(file, raw); const query = vi.fn();
  expect(await currentWorkerHealthy(query, file)).toBe(false);
  expect(query).not.toHaveBeenCalled();
});

it.each([
  { pid: 2147483647 }, { pid: 0 },
  { processBirth: "00000000-0000-0000-0000-000000000000:1" },
  { startedAt: "inválido" }, { readyAt: null },
  { readyAt: "2099-01-01T00:00:00.000Z" },
  { readyAt: "2000-01-01T00:00:00.000Z" },
])("processo ausente/reutilizado ou marcador incoerente falha fechado: %j", async fields => {
  const instance = beginWorkerInstance(file); instance.ready(); edit(fields);
  const query = vi.fn(); expect(await currentWorkerHealthy(query, file)).toBe(false);
  expect(query).not.toHaveBeenCalled();
});

it("reinício durante a consulta invalida o resultado recebido", async () => {
  const instance = beginWorkerInstance(file); instance.ready();
  const query = async () => { const next = beginWorkerInstance(file); next.ready(); return { rows: [{ healthy: true }] }; };
  expect(await currentWorkerHealthy(query, file)).toBe(false);
});

it("indisponibilidade do banco e prova ausente não viram sucesso", async () => {
  const instance = beginWorkerInstance(file); instance.ready();
  expect(await currentWorkerHealthy(async () => { throw new Error("db indisponível"); }, file)).toBe(false);
  expect(await currentWorkerHealthy(async () => ({ rows: [] }), file)).toBe(false);
});
