import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contrato entre o proxy e as páginas: TODO header interno `x-auth-*` lido pelo
 * app precisa ser um header que o `proxy.ts` realmente injeta.
 *
 * Header que o proxy deixa de setar não quebra nada visível: `get()` devolve
 * null, a comparação vira `false` e a página perde funções em silêncio (a de
 * Config, por exemplo, os botões de mutação). Typecheck e lint não pegam, e o
 * E2E não roda no gate local.
 */

const RAIZ = fileURLToPath(new URL("../..", import.meta.url));
const LIDOS = /\.get\(\s*"(x-auth-[a-z-]+)"/g;
const ESCRITOS = /forwardedHeaders\.set\(\s*"(x-auth-[a-z-]+)"/g;
const APAGADOS = /headers\.delete\(\s*"(x-auth-[a-z-]+)"/g;

async function arquivosDe(dir: string): Promise<string[]> {
  const entradas = await readdir(path.join(RAIZ, dir), { withFileTypes: true, recursive: true });
  return entradas
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name));
}

describe("contrato de headers internos entre proxy e app", () => {
  it("todo x-auth-* lido pelo app é injetado pelo proxy", async () => {
    const proxy = await readFile(path.join(RAIZ, "proxy.ts"), "utf8");
    const injetados = new Set(
      [...proxy.matchAll(ESCRITOS)].map((m) => m[1] as string),
    );
    expect(injetados.size).toBeGreaterThan(0);

    const arquivos = [...await arquivosDe("app"), ...await arquivosDe("src")];
    const lidos = new Map<string, string[]>();
    for (const arquivo of arquivos) {
      const conteudo = await readFile(arquivo, "utf8");
      for (const m of conteudo.matchAll(LIDOS)) {
        const header = m[1] as string;
        lidos.set(header, [...(lidos.get(header) ?? []), path.relative(RAIZ, arquivo)]);
      }
    }
    expect(lidos.size).toBeGreaterThan(0);

    const orfaos = [...lidos.entries()].filter(([header]) => !injetados.has(header));
    expect(
      orfaos.map(([header, arquivos]) => `${header} lido em ${arquivos.join(", ")}`),
      "header interno lido mas nunca injetado pelo proxy — vira null silencioso",
    ).toEqual([]);
  });

  it("todo x-auth-* injetado é APAGADO na entrada, antes de qualquer ramo", async () => {
    // O nginx repassa headers do cliente e `new Headers(request.headers)` copia
    // tudo. Sem o delete, o valor que o cliente mandou sobrevive nos ramos que
    // encaminham sem autenticar — e passa a valer como identidade no momento em
    // que alguém ler o header ali.
    const proxy = await readFile(path.join(RAIZ, "proxy.ts"), "utf8");
    const injetados = [...proxy.matchAll(ESCRITOS)].map((m) => m[1] as string);
    const apagados = new Set([...proxy.matchAll(APAGADOS)].map((m) => m[1] as string));

    expect(
      injetados.filter((header) => !apagados.has(header)),
      "header de identidade injetado pelo proxy mas não apagado na entrada — o cliente consegue forjar",
    ).toEqual([]);

    // A limpeza precisa estar em `requestHeaders`, que é por onde TODO ramo
    // passa; apagar dentro de um ramo específico deixaria os outros expostos.
    const corpoRequestHeaders = proxy.slice(
      proxy.indexOf("function requestHeaders"),
      proxy.indexOf("function withCsp"),
    );
    for (const header of apagados) {
      expect(corpoRequestHeaders).toContain(`headers.delete("${header}")`);
    }
  });
});
