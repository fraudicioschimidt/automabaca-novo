import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type ponte from "@automabaca/dominio";

// Cada lado pelo caminho (o do navegador pelo carregador do Node, com o mesmo
// .wasm): o resto do código entra pelo nome do pacote, e o bundler (ou o alias
// do vitest) escolhe o lado.
const servidor = createRequire(import.meta.url)(path.resolve("rust/crates/ponte/index.cjs")) as typeof ponte;
const navegador = (await import(pathToFileURL(path.resolve("rust/crates/ponte/wasm-node.mjs")).href) as { default: typeof ponte }).default;

const lados = { servidor, navegador } as Record<string, Record<string, (...args: unknown[]) => unknown>>;

function nomesDoTipo(): string[] {
  const fonte = ts.createSourceFile("index.d.ts", readFileSync("rust/crates/ponte/index.d.ts", "utf8"), ts.ScriptTarget.Latest, true);
  for (const statement of fonte.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const tipo = statement.declarationList.declarations[0]?.type;
    if (tipo && ts.isTypeLiteralNode(tipo)) return tipo.members.map((member) => member.name?.getText(fonte) ?? "").sort();
  }
  throw new Error("index.d.ts sem `declare const dominio: { ... }`");
}

function resultado(funcao: () => unknown): unknown {
  try {
    return { valor: funcao() };
  } catch (error) {
    return { erro: error instanceof Error ? error.message : `não é Error: ${String(error)}` };
  }
}

describe("ponte Rust do crate dominio", () => {
  it("os dois lados são o binário deste workspace", () => {
    const cargo = readFileSync("rust/Cargo.toml", "utf8");
    const versaoDoWorkspace = /\[workspace\.package\][^[]*?\nversion = "([^"]+)"/.exec(cargo)?.[1];
    expect(versaoDoWorkspace).toMatch(/^\d+\.\d+\.\d+$/);
    expect(servidor.versao()).toBe(versaoDoWorkspace);
    expect(navegador.versao()).toBe(versaoDoWorkspace);
  });

  it("N-API, WebAssembly e o index.d.ts têm as mesmas funções", () => {
    expect(Object.keys(servidor).sort()).toEqual(nomesDoTipo());
    expect(Object.keys(navegador).sort()).toEqual(nomesDoTipo());
  });

  // Os testes de cada módulo rodam também contra o WebAssembly (`npm run
  // test:ponte-wasm`); aqui fica a forma dos valores que cruzam a ponte.
  it("os dois lados devolvem a mesma coisa: null, Array e Error com a mensagem do domínio", () => {
    const casos: Array<[string, unknown[]]> = [
      ["cronMaxGapMinutes", ["15 1-23/2 * * *"]],
      ["cronMaxGapMinutes", ["0 0 1 * *"]],
      ["cronFiringMinutes", ["0 0 * * 0/3"]],
      ["latestCronFiring", ["5 0 * * *", Date.parse("2026-09-23T12:00:00Z"), Date.parse("2026-09-24T03:05:00Z"), 3]],
      ["latestCronFiring", ["5 0 * * *", Date.parse("2026-09-24T03:05:00Z"), Date.parse("2026-09-24T12:00:00Z"), 3]],
    ];
    for (const [nome, args] of casos) {
      const esperado = resultado(() => lados.servidor![nome]!(...args));
      expect(resultado(() => lados.navegador![nome]!(...args)), `${nome}(${JSON.stringify(args)})`).toEqual(esperado);
    }
    expect(Array.isArray(navegador.cronFiringMinutes("0 0 * * 0/3"))).toBe(true);
    expect(navegador.latestCronFiring("5 0 * * *", 0, 1, 3)).toBeNull();
  });
});
