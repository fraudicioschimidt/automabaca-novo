import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allowMockQuery, mockFixture } from "@/app/(painel)/_mock";

describe("contratos de runtime", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("não aceita mock em produção fora do ambiente visual e banco E2E isolados", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VISUAL_TEST_MODE", "");
    expect(allowMockQuery("1")).toBe(false);
    vi.stubEnv("VISUAL_TEST_MODE", "1");
    vi.stubEnv("DATABASE_URL", "postgresql://localhost/automabaca");
    expect(allowMockQuery("1")).toBe(false);
    vi.stubEnv("DATABASE_URL", "postgresql://localhost/automabaca_e2e");
    expect(allowMockQuery("1")).toBe(true);
    expect(allowMockQuery(undefined)).toBe(false);
  });

  it("fixture de demonstração só carrega onde o guarda admite", async () => {
    // A regra de lint (eslint.config.mjs) só aceita `import()` do mock dentro
    // do carregador de `mockFixture`: o que ela deixa passar é isto.
    const load = vi.fn(async () => ({ TOOLS: "fixture" }));
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VISUAL_TEST_MODE", "");
    await expect(mockFixture("1", load)).resolves.toBeNull();
    expect(load, "produção nem carrega o módulo do mock").not.toHaveBeenCalled();
    vi.stubEnv("VISUAL_TEST_MODE", "1");
    vi.stubEnv("DATABASE_URL", "postgresql://localhost/automabaca_e2e");
    await expect(mockFixture("1", load)).resolves.toEqual({ TOOLS: "fixture" });
    await expect(mockFixture(undefined, load)).resolves.toBeNull();
    expect(load).toHaveBeenCalledOnce();
  });

  it("wrapper canônico ativa o modo visual antes do guarda isolado", () => {
    const result = spawnSync("bash", ["scripts/run-playwright-canonical.sh", "true"], {
      cwd: new URL("../..", import.meta.url),
      encoding: "utf8",
      env: { ...process.env, VISUAL_TEST_MODE: "", DATABASE_URL: "" },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("DATABASE_URL deve apontar para um banco *_e2e*");
    expect(result.stderr).not.toContain("VISUAL_TEST_MODE=1 é obrigatório");
  });
});
