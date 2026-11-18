import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type ponte from "@automabaca/dominio";

// O `normalizeStr` portado usa, no servidor, as tabelas do Rust (NFD, minúsculas
// e a lista de `\p{Diacritic}` tirada do V8) e, no navegador, as funções do
// host. Cada ponto de código do Unicode dá nos dois lados o que o V8 dá: uma
// versão nova do Unicode no Node ou na std do Rust aparece aqui.
const servidor = createRequire(import.meta.url)(path.resolve("rust/crates/ponte/index.cjs")) as typeof ponte;
const navegador = (await import(pathToFileURL(path.resolve("rust/crates/ponte/wasm-node.mjs")).href) as { default: typeof ponte }).default;

const v8 = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();

describe("normalizeStr: servidor e navegador dão o que o V8 dá", () => {
  it("em cada ponto de código, sozinho e entre letras com acento", { timeout: 120_000 }, () => {
    const divergentes: string[] = [];
    for (let code = 0; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const char = String.fromCodePoint(code);
      for (const text of [char, `A${char}e\u0301`]) {
        const esperado = v8(text);
        for (const [lado, dominio] of Object.entries({ servidor, navegador })) {
          if (dominio.normalizeStr(text) !== esperado && divergentes.length < 20) {
            divergentes.push(`${lado} U+${code.toString(16).toUpperCase()}`);
          }
        }
      }
    }
    expect(divergentes).toEqual([]);
  });

  it("na ordem canônica das marcas combinantes", () => {
    const marcas = ["\u0301", "\u0327", "\u0323", "\u0308", "\u031B", "\u0345", "\u05B0", "\u0E48"];
    for (const base of ["a", "E", "\u1ECD", "\u01EA", "\u1FB3", "\uFB01"]) {
      for (const primeira of marcas) {
        for (const segunda of marcas) {
          const text = `${base}${primeira}${segunda}`;
          expect(servidor.normalizeStr(text), JSON.stringify(text)).toBe(v8(text));
          expect(navegador.normalizeStr(text), JSON.stringify(text)).toBe(v8(text));
        }
      }
    }
  });
});

describe("corte da Dupla Chance: o texto sem acento tem o tamanho que o V8 dá", () => {
  // `stripDoubleChanceFromSelection` acha o sufixo no texto em NFD sem as
  // marcas U+0300–U+036F e corta o original naquele índice UTF-16: um ponto
  // de código que decompõe diferente nos dois lados muda o corte.
  it("em cada ponto de código", { timeout: 120_000 }, () => {
    const divergentes: string[] = [];
    for (let code = 0; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const text = `${String.fromCodePoint(code)}x dc`;
      const semAcento = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const esperado = text.slice(0, semAcento.length - " dc".length).trim().toWellFormed();
      for (const [lado, dominio] of Object.entries({ servidor, navegador })) {
        if (dominio.stripDoubleChanceFromSelection(text) !== esperado && divergentes.length < 20) {
          divergentes.push(`${lado} U+${code.toString(16).toUpperCase()}`);
        }
      }
    }
    expect(divergentes).toEqual([]);
  });
});
