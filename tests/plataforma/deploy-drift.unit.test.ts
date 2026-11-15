import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compararArquivo, renderCompose, releaseFromLiveCompose, imageIsPinned, significativo, ILEGIVEL } from "@/scripts/check-deploy-drift.mjs";

const RAIZ = process.cwd();
const composeVersionado = readFileSync(join(RAIZ, "deploy/compose.yaml"), "utf8");

const WEB_IMAGE = `ghcr.io/fraudicioschimidt/automabaca-novo-web@sha256:${"a".repeat(64)}`;
const WORKER_IMAGE = `ghcr.io/fraudicioschimidt/automabaca-novo-worker@sha256:${"b".repeat(64)}`;
const RELEASE = {
  releaseId: "exemplo-20260917-abc1234",
  releaseSha: "abc1234def5678901234567890123456789012ab",
  webImage: WEB_IMAGE,
  workerImage: WORKER_IMAGE,
};

describe("Deriva entre o servidor e o repositório", () => {
  it("renderiza o compose com a release no lugar dos marcadores", () => {
    const rendered = renderCompose(composeVersionado, RELEASE);
    expect(rendered).not.toContain("__RELEASE_ID__");
    expect(rendered).not.toContain("__RELEASE_SHA__");
    expect(rendered).not.toContain("__WEB_IMAGE__");
    expect(rendered).not.toContain("__WORKER_IMAGE__");
    expect(rendered).toContain(`image: ${WEB_IMAGE}`);
    expect(rendered).toContain(`image: ${WORKER_IMAGE}`);
    expect(rendered).toContain(`AUTOMABACA_RELEASE_SHA: ${RELEASE.releaseSha}`);
  });

  it("lê a release publicada de volta do compose vivo", () => {
    expect(releaseFromLiveCompose(renderCompose(composeVersionado, RELEASE))).toEqual(RELEASE);
  });

  it("exige digest imutável nas imagens da aplicação", () => {
    expect(imageIsPinned(WEB_IMAGE)).toBe(true);
    expect(imageIsPinned(WORKER_IMAGE)).toBe(true);
    expect(imageIsPinned("automabaca-novo-web:release-test")).toBe(false);
  });

  it("um compose vivo renderizado da mesma fonte não acusa deriva", () => {
    const vivo = renderCompose(composeVersionado, RELEASE);
    expect(compararArquivo({ nome: "compose.yaml", vivo, versionado: vivo }).estado).toBe("igual");
  });

  it("acusa um campo trocado à mão, mesmo com a release batendo", () => {
    const adulterado = renderCompose(composeVersionado, RELEASE).replace("mem_limit: 1g", "mem_limit: 4g");
    expect(compararArquivo({
      nome: "compose.yaml", vivo: adulterado, versionado: renderCompose(composeVersionado, RELEASE),
    }).estado).toBe("divergente");
  });

  it("comentário e linha em branco não contam como deriva", () => {
    expect(significativo("# nota\n\nfoo: 1\n")).toBe(significativo("foo: 1\n# outra nota\n".split("\n").reverse().join("\n")));
  });

  it("distingue ausente, ilegível e divergente — nenhum deles vira 'igual'", () => {
    expect(compararArquivo({ nome: "x", vivo: null, versionado: "a" }).estado).toBe("ausente_no_servidor");
    expect(compararArquivo({ nome: "x", vivo: "a", versionado: null }).estado).toBe("ausente_no_repositorio");
    expect(compararArquivo({ nome: "x", vivo: ILEGIVEL, versionado: "a" }).estado).toBe("ilegivel_sem_privilegio");
    expect(compararArquivo({ nome: "x", vivo: "a", versionado: "b" }).estado).toBe("divergente");
  });
});
