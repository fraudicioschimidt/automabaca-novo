import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeRemoveTreeSync } from "@/scripts/lib/safe-fs.mjs";
import { GET, resetObservabilityHealthCache } from "@/app/api/health/observability/route";

const metric = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/src/infra/operational-metrics", () => ({ recordOperationalMetric: metric }));

let statusDir: string;
beforeEach(async () => {
  metric.mockClear();
  resetObservabilityHealthCache();
  statusDir = await mkdtemp(path.join(tmpdir(), "automabaca-health-route-"));
  vi.stubEnv("OBSERVABILITY_STATUS_DIR", statusDir);
  vi.stubEnv("OBSERVABILITY_METRICS_IN_TEST", "true");
});
afterEach(() => {
  vi.unstubAllEnvs();
  safeRemoveTreeSync(tmpdir(), statusDir);
});

/** A métrica sai depois da resposta, sem ninguém esperar: deixa o import e a gravação terminarem. */
const settle = async () => {
  await vi.dynamicImportSettled();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const request = () => new Request("http://localhost/api/health/observability", {
  headers: { "x-correlation-id": "proxy_observability-test" },
});
async function publishStatus(overrides: Record<string, unknown> = {}) {
  await writeFile(path.join(statusDir, "status.json"), JSON.stringify({
    schemaVersion: 1, observedAt: new Date().toISOString(), ok: true,
    collection: "fresh", export: "fresh", offsite: "fresh", reasons: [],
    archivePath: "/private/synthetic-archive", ...overrides,
  }));
}

describe("GET /api/health/observability", () => {
  it("responde 200 ao watchdog saudável, sem expor metadados internos e com cache curto", async () => {
    await publishStatus();
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=2");
    expect(response.headers.get("x-correlation-id")).toBe("proxy_observability-test");
    await expect(response.json()).resolves.toEqual({
      ok: true, collection: "fresh", export: "fresh", offsite: "fresh", reasons: [],
    });
    // Sonda pública: um GET anônimo não pode virar uma linha de métrica no banco.
    await settle();
    expect(metric).not.toHaveBeenCalled();
  });

  it("torna degradação acionável com 503 e conserva a razão pública", async () => {
    await publishStatus({ ok: false, offsite: "pending", reasons: ["offsite_pending"] });
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("public, max-age=2");
    await expect(response.json()).resolves.toEqual({
      ok: false, collection: "fresh", export: "fresh", offsite: "pending", reasons: ["offsite_pending"],
    });
    // O 503 é o veredito do vigia, que já alerta; não é falha HTTP para o SLO.
    await settle();
    expect(metric).not.toHaveBeenCalled();
  });

  it("não expõe o detalhe do backup, só a razão", async () => {
    await publishStatus({ ok: false, reasons: ["backup_stale"],
      backup: { state: "stale", createdAt: "2026-09-23T04:21:00Z", failedAt: null, bets: 1234 } });
    const response = await GET(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false, collection: "fresh", export: "fresh", offsite: "fresh", reasons: ["backup_stale"],
    });
  });

  it("falha fechada quando o watchdog não publicou status, sem transformar ausência em 500", async () => {
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("public, max-age=2");
    await expect(response.json()).resolves.toEqual({
      ok: false, collection: "unavailable", export: "unavailable", offsite: "unavailable", reasons: ["watchdog_unavailable"],
    });
  });

  it("SEC-04: cache de 2s coalescido evita I/O repetido no flood", async () => {
    await publishStatus();
    const first = await GET(request());
    expect(first.status).toBe(200);
    // remove o status do disco; respostas seguintes devem vir do cache em memória
    const { unlink } = await import("node:fs/promises");
    await unlink(path.join(statusDir, "status.json"));
    for (let i = 0; i < 4; i++) {
      const response = await GET(request());
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true, collection: "fresh", export: "fresh", offsite: "fresh", reasons: [],
      });
    }
  });
});
