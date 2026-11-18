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

describe("canonicalCountry: a caixa do país desconhecido é a que o V8 dá", () => {
  // Cada palavra sai com `charAt(0).toUpperCase()` e o resto em
  // `toLowerCase()`: no servidor, a std do Rust; no navegador, o host.
  const titulo = (text: string) =>
    text.trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");

  it("em cada ponto de código, no começo e no meio da palavra", { timeout: 120_000 }, () => {
    const divergentes: string[] = [];
    for (let code = 0; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const char = String.fromCodePoint(code);
      for (const text of [`${char}zq`, `Q${char}Z`]) {
        const esperado = titulo(text);
        for (const [lado, dominio] of Object.entries({ servidor, navegador })) {
          if (dominio.canonicalCountry(text) !== esperado && divergentes.length < 20) {
            divergentes.push(`${lado} U+${code.toString(16).toUpperCase()} em ${JSON.stringify(text)}`);
          }
        }
      }
    }
    expect(divergentes).toEqual([]);
  });
});

describe("troca do nome do time na seleção: a caixa e o limite do /iu que o V8 dá", () => {
  // O TS buscava o nome do time com `/(?<![\p{L}\p{N}])<nome>(?![\p{L}\p{N}])/giu`.
  // O Rust compara cada caractere pela dobra simples (o `toLowerCase` de um
  // caractere mais as exceções de `js-text`) e o limite pela classe com `iu`.
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\\-]/g, "\\$&");
  // Nas seleções daqui, depois do nome só vem a linha ("-1") ou o caractere
  // testado, e só a linha (ou nada) deixa trocar.
  const troca = (selecao: string, nome: string) =>
    selecao.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(nome)}(?![\\p{L}\\p{N}])`, "giu"), (found, offset: number) =>
      /^(?:-1|$)/.test(selecao.slice(offset + found.length).trimStart()) ? "Zz" : found);
  const rodar = (dominio: typeof ponte, selecao: string, nome: string) =>
    dominio.rewriteSelecaoWithMatchedTeams(selecao, nome, "", "Zz", "Qq");

  // Os pares que o `/iu` iguala, sem supor que se ligam por maiúscula ou
  // minúscula (ﬅ e ﬆ não se ligam): a classe de cada bloco de 256 pontos
  // contra todo o texto dá os pares entre blocos, e cada caractere contra o
  // próprio bloco, os de dentro. Fora dos planos 0 e 1 nada dobra.
  function paresDoV8(): Array<[number, number]> {
    const pontos: number[] = [];
    for (let code = 0; code < 0x20000; code++) if (code < 0xd800 || code > 0xdfff) pontos.push(code);
    const tudo = pontos.map((code) => String.fromCodePoint(code)).join("");
    const pares: Array<[number, number]> = [];
    const hex = (code: number) => code.toString(16);
    for (let inicio = 0; inicio < 0x20000; inicio += 256) {
      const bloco = pontos.filter((code) => code >= inicio && code < inicio + 256);
      const textoDoBloco = bloco.map((code) => String.fromCodePoint(code)).join("");
      for (const found of tudo.matchAll(new RegExp(`[\\u{${hex(inicio)}}-\\u{${hex(inicio + 255)}}]`, "giu"))) {
        const outro = found[0].codePointAt(0)!;
        if (outro >= inicio && outro < inicio + 256) continue;
        for (const code of bloco) if (new RegExp(`^\\u{${hex(code)}}$`, "iu").test(found[0])) pares.push([code, outro]);
      }
      for (const code of bloco) {
        for (const found of textoDoBloco.matchAll(new RegExp(`\\u{${hex(code)}}`, "giu"))) {
          const outro = found[0].codePointAt(0)!;
          if (outro !== code) pares.push([code, outro]);
        }
      }
    }
    expect(/[\u{20000}-\u{10ffff}]/iu.test(tudo)).toBe(false);
    return pares;
  }

  it("em cada par que o V8 iguala e em cada par de maiúscula e minúscula", { timeout: 120_000 }, () => {
    const pares = paresDoV8();
    for (let code = 0; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const char = String.fromCodePoint(code);
      for (const outro of [char.toUpperCase(), char.toLowerCase()]) {
        const pontos = [...outro];
        if (pontos.length === 1 && outro !== char) pares.push([code, pontos[0]!.codePointAt(0)!]);
      }
    }
    expect(pares.length).toBeGreaterThan(4000);
    const divergentes: string[] = [];
    for (const [a, b] of pares) {
      const nome = String.fromCodePoint(a);
      const selecao = `${String.fromCodePoint(b)} -1`;
      const esperado = troca(selecao, nome);
      for (const [lado, dominio] of Object.entries({ servidor, navegador })) {
        if (rodar(dominio, selecao, nome) !== esperado && divergentes.length < 20) {
          divergentes.push(`${lado} U+${a.toString(16).toUpperCase()} contra U+${b.toString(16).toUpperCase()}`);
        }
      }
    }
    expect(divergentes).toEqual([]);
  });

  it("com cada ponto de código colado ao nome", { timeout: 120_000 }, () => {
    const divergentes: string[] = [];
    for (let code = 0; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const char = String.fromCodePoint(code);
      for (const selecao of [`${char}Ab -1`, `ab${char} -1`]) {
        const esperado = troca(selecao, "Ab");
        for (const [lado, dominio] of Object.entries({ servidor, navegador })) {
          if (rodar(dominio, selecao, "Ab") !== esperado && divergentes.length < 20) {
            divergentes.push(`${lado} U+${code.toString(16).toUpperCase()} em ${JSON.stringify(selecao)}`);
          }
        }
      }
    }
    expect(divergentes).toEqual([]);
  });
});
