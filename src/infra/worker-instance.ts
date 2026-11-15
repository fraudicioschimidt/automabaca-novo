import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WORKER_HEARTBEAT_STALE_MS } from "@/src/domain/health";

const workerInstancePath = () => path.join(tmpdir(), "automabaca-worker-instance.json");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type WorkerInstanceMarker = {
  version: 1;
  instanceId: string;
  pid: number;
  processBirth: string | null;
  startedAt: string;
  readyAt: string | null;
};
export type WorkerHeartbeatProof = { workerInstance: Pick<WorkerInstanceMarker, "version" | "instanceId" | "startedAt" | "readyAt"> };

/** O que o heartbeat grava no `output` do job e o healthcheck procura. */
function heartbeatProof(marker: WorkerInstanceMarker): WorkerHeartbeatProof {
  return { workerInstance: { version: marker.version, instanceId: marker.instanceId, startedAt: marker.startedAt, readyAt: marker.readyAt } };
}

/** PID sozinho pode ser reutilizado após restart. No Linux, confere também
 * boot do kernel e instante de criação do processo (ticks desde o boot). */
function linuxProcessBirth(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const ticks = fields[19]; // campo 22; a lista começa no estado (campo 3).
    if (!ticks || !/^\d+$/.test(ticks) || fields[0] === "Z" || fields[0] === "X") return null;
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return /^[0-9a-f-]{36}$/.test(boot) ? `${boot}:${ticks}` : null;
  } catch { return null; }
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function readMarker(file: string): WorkerInstanceMarker | null {
  try {
    const raw = readFileSync(file, "utf8");
    if (raw.length > 2048) return null;
    const m = JSON.parse(raw) as Partial<WorkerInstanceMarker> | null;
    if (!m || m.version !== 1 || typeof m.instanceId !== "string" || !UUID.test(m.instanceId)
      || typeof m.pid !== "number" || !Number.isSafeInteger(m.pid) || m.pid <= 0
      || !(m.processBirth === null || (typeof m.processBirth === "string" && /^[0-9a-f-]{36}:\d+$/.test(m.processBirth)))
      || !validDate(m.startedAt) || !(m.readyAt === null || validDate(m.readyAt))) return null;
    return m as WorkerInstanceMarker;
  } catch { return null; }
}

/** O ponteiro só é substituído no início. Prontidão e shutdown alteram apenas
 * o arquivo do próprio UUID, sem corrida de read/check/unlink do sucessor. */
export function readWorkerInstance(file = workerInstancePath()): WorkerInstanceMarker | null {
  const pointer = readMarker(file);
  if (!pointer || pointer.readyAt !== null) return null;
  const state = readMarker(`${file}.${pointer.instanceId}`);
  if (!state || state.instanceId !== pointer.instanceId || state.pid !== pointer.pid
    || state.processBirth !== pointer.processBirth || state.startedAt !== pointer.startedAt) return null;
  return state;
}

function writeMarker(file: string, marker: WorkerInstanceMarker) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(marker), { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch { /* rename já consumiu o temporário */ }
  }
}

export function beginWorkerInstance(file = workerInstancePath()) {
  const processBirth = linuxProcessBirth(process.pid);
  if (process.platform === "linux" && !processBirth) throw new Error("Não foi possível identificar o processo do worker.");
  const marker: WorkerInstanceMarker = {
    version: 1, instanceId: randomUUID(), pid: process.pid, processBirth,
    startedAt: new Date().toISOString(), readyAt: null,
  };
  let stopped = false;
  const stateFile = `${file}.${marker.instanceId}`;
  const previous = readMarker(file);
  writeMarker(stateFile, marker);
  writeMarker(file, marker);
  if (previous) {
    try { unlinkSync(`${file}.${previous.instanceId}`); } catch { /* estado anterior já removido */ }
  }
  return {
    ready() {
      if (stopped || readWorkerInstance(file)?.instanceId !== marker.instanceId) throw new Error("Execução do worker já encerrada ou substituída.");
      marker.readyAt = new Date().toISOString();
      writeMarker(stateFile, marker);
      if (readWorkerInstance(file)?.instanceId !== marker.instanceId) throw new Error("Execução do worker substituída durante a inicialização.");
    },
    proof(): WorkerHeartbeatProof | null {
      if (stopped || !marker.readyAt) return null;
      return heartbeatProof(marker);
    },
    stop() {
      stopped = true;
      // Nunca modifica o ponteiro comum, mesmo se um sucessor iniciar agora.
      try { unlinkSync(stateFile); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    },
  };
}
export type WorkerInstance = ReturnType<typeof beginWorkerInstance>;

const WORKER_HEALTH_QUERY = `SELECT EXISTS (
  SELECT 1 FROM pgboss.job
  WHERE name = 'health.heartbeat' AND state = 'completed'
    AND completed_on >= $1::timestamptz
    AND completed_on >= now() - ($2::double precision * interval '1 millisecond')
    AND completed_on <= now() + interval '30 seconds'
    AND output @> $3::jsonb
) AS healthy`;
export type WorkerHealthQuery = (sql: string, values: unknown[]) => Promise<{ rows: Array<{ healthy: boolean }> }>;

function eligible(marker: WorkerInstanceMarker | null, now: number): marker is WorkerInstanceMarker & { readyAt: string } {
  if (!marker?.readyAt || !marker.processBirth) return false;
  const started = Date.parse(marker.startedAt); const ready = Date.parse(marker.readyAt);
  return started > 0 && ready >= started && ready <= now + 30_000
    && linuxProcessBirth(marker.pid) === marker.processBirth;
}

/** Uma consulta já existente, agora exigindo o resultado do heartbeat executado
 * por este processo depois do boot. Nada é inferido do payload enviado à fila. */
export async function currentWorkerHealthy(query: WorkerHealthQuery, file = workerInstancePath()): Promise<boolean> {
  const marker = readWorkerInstance(file);
  if (!eligible(marker, Date.now())) return false;
  const proof = heartbeatProof(marker);
  try {
    const result = await query(WORKER_HEALTH_QUERY, [marker.readyAt, WORKER_HEARTBEAT_STALE_MS, JSON.stringify(proof)]);
    // Se reiniciou durante a consulta, o resultado do processo anterior não vale.
    const current = readWorkerInstance(file);
    return result.rows[0]?.healthy === true && eligible(current, Date.now())
      && JSON.stringify(current) === JSON.stringify(marker);
  } catch { return false; }
}
