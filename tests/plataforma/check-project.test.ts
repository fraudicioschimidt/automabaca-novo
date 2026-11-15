import { describe, expect, it } from "vitest";
import { bridgeImporters, classifyImpact, treeScanningTests } from "@/scripts/check-project.mjs";

describe("classificacao do check incremental", () => {
  it("encerra cedo quando somente documentacao mudou", () => {
    const impact = classifyImpact(["docs/RUNBOOK.md", "CLAUDE.md", "deploy/README.md"]);
    expect(impact.documentationOnly).toBe(true);
    expect(impact.codeFiles).toEqual([]);
  });

  it("codigo de interface vai para lint e testes relacionados e avisa do navegador", () => {
    const impact = classifyImpact(["app/_design/DesignScreen.tsx"]);
    expect(impact).toMatchObject({ documentationOnly: false, fullTests: false, browserChanged: true });
    expect(impact.lintFiles).toEqual(["app/_design/DesignScreen.tsx"]);
  });

  it("escala para todos os testes quando muda contrato global", () => {
    for (const file of ["package-lock.json", "vitest.config.ts", "prisma/schema.prisma"]) {
      expect(classifyImpact([file]).fullTests, file).toBe(true);
    }
  });

  it("mudança em rust/ roda o Rust e os testes de quem importa a ponte", () => {
    expect(classifyImpact(["rust/crates/dominio/src/cron.rs"]).rustChanged).toBe(true);
    expect(classifyImpact(["src/domain/cron-cadence.ts"]).rustChanged).toBe(false);
    expect(bridgeImporters()).toContain("src/domain/cron-cadence.ts");
  });

  it("escala quando codigo foi excluido", () => {
    const impact = classifyImpact(["src/services/removed.ts"], () => false);
    expect(impact.deletedCode).toBe(true);
    expect(impact.fullTests).toBe(true);
    expect(impact.lintFiles).toEqual([]);
  });

  it("aplica os gates de seguranca a scripts, deploy e infraestrutura", () => {
    const script = classifyImpact(["scripts/local-setup.sh"]);
    expect(script.operationsChanged).toBe(true);
    expect(script.shellFiles).toEqual(["scripts/local-setup.sh"]);
    expect(classifyImpact(["infra/example.conf"]).operationsChanged).toBe(true);
    expect(classifyImpact(["deploy/publicar.sh"]).operationsChanged).toBe(true);
    expect(classifyImpact(["package.json"]).fullTests).toBe(false);
  });

  it("inclui a simulação do ambiente quando muda o bootstrap shell do navegador", () => {
    const impact = classifyImpact(["scripts/lib/test-runtime-env.sh"]);
    expect(impact.scriptTests).toEqual(["tests/plataforma/test-runtime-env.test.ts"]);
    expect(classifyImpact(["docs/RUNBOOK.md"]).scriptTests).toEqual([]);
  });

  it("acha os testes que varrem a arvore, que o vitest related nao alcanca", () => {
    const encontrados = treeScanningTests();
    // Desce nas subpastas por area e reconhece o import relativo de qualquer profundidade.
    expect(encontrados).toContain("tests/plataforma/architecture-boundaries.test.ts");
    expect(encontrados).toContain("tests/operacao/fixture-de-dlq-vs-watcher.test.ts");
    expect(encontrados.filter((file) => file.includes("\\"))).toEqual([]);
  });
});
