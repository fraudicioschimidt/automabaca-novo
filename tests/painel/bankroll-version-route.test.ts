import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), version: vi.fn(), metric: vi.fn() }));
vi.mock("@/app/(painel)/_auth", () => ({ canManage: mocks.auth }));
vi.mock("@/src/services/painel/queries/bankrolls", () => ({ getBankrollVersion: mocks.version }));
vi.mock("@/src/infra/operational-metrics", () => ({ recordOperationalMetric: mocks.metric }));
import { GET, POST } from "@/app/api/bankrolls/[slug]/version/route";
beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue(true); mocks.version.mockResolvedValue("version"); });
it("exige sessão antes de consultar banca", async () => {
  mocks.auth.mockResolvedValue(false);
  expect((await GET(new Request("https://local.test/api"), { params: Promise.resolve({ slug: "test" }) })).status).toBe(401);
  expect(mocks.version).not.toHaveBeenCalled();
});
it("devolve só versão, sem cache compartilhado nem dados de apostas", async () => {
  const result = await GET(new Request("https://local.test/api", { headers: { "x-correlation-id": "http_poll" } }), { params: Promise.resolve({ slug: "test" }) });
  expect(await result.json()).toEqual({ version: "version" });
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  expect(result.headers.get("x-correlation-id")).toBe("http_poll");
  expect(mocks.metric).not.toHaveBeenCalled();
});
it("recusa slug inválido e informa banca ausente", async () => {
  expect((await GET(new Request("https://local.test/api"), { params: Promise.resolve({ slug: "../private" }) })).status).toBe(400);
  mocks.version.mockResolvedValue(null);
  expect((await GET(new Request("https://local.test/api"), { params: Promise.resolve({ slug: "test" }) })).status).toBe(404);
});
it("mede só duração limitada com sessão e origem válida", async () => {
  const request = (durationMs: number, origin = "https://local.test") => new Request("https://local.test/api", {
    method: "POST", headers: { origin }, body: JSON.stringify({ durationMs }),
  });
  expect((await POST(request(200))).status).toBe(204);
  expect(mocks.metric).toHaveBeenCalledWith(expect.objectContaining({ name: "sharp.browser.refresh", durationMs: 200 }));
  expect((await POST(request(70_000))).status).toBe(400);
  expect((await POST(request(200, "https://foreign.test"))).status).toBe(403);
  expect(mocks.metric).toHaveBeenCalledOnce();
});
it("corta corpo grande sem Content-Length antes de ler o stream inteiro", async () => {
  let pulled = 0;
  const chunk = new TextEncoder().encode("x".repeat(100));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      if (pulled > 1_000) controller.close();
      else controller.enqueue(chunk);
    },
  });
  const request = new Request("https://local.test/api", {
    method: "POST", headers: { origin: "https://local.test" }, body, duplex: "half",
  } as RequestInit & { duplex: "half" });
  expect((await POST(request)).status).toBe(413);
  expect(pulled).toBeLessThan(20);
  expect(mocks.metric).not.toHaveBeenCalled();
});

it("consulta a versão de endereço longo já gerado, sem renomear o tipster", async () => {
  const slug = `${"x".repeat(120)}-2`;
  const result = await GET(new Request("https://local.test/api"), { params: Promise.resolve({ slug }) });
  expect(result.status).toBe(200);
  expect(mocks.version).toHaveBeenCalledWith(slug);
  mocks.version.mockClear();
  expect((await GET(new Request("https://local.test/api"), { params: Promise.resolve({ slug: "x".repeat(201) }) })).status).toBe(400);
  expect(mocks.version).not.toHaveBeenCalled();
});
