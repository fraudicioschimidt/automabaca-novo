import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type ponte from "@automabaca/dominio";

// O regex do domínio portado roda no `regress` no servidor e no RegExp do host
// no navegador, com a busca global, a troca e a divisão escritas em Rust por
// cima. Aqui cada padrão do catálogo, e os que exercitam as quinas da
// especificação, dão nos dois lados o que o V8 dá.
const servidor = createRequire(import.meta.url)(path.resolve("rust/crates/ponte/index.cjs")) as typeof ponte;
const navegador = (await import(pathToFileURL(path.resolve("rust/crates/ponte/wasm-node.mjs")).href) as { default: typeof ponte }).default;
const lados = { servidor, navegador };

const QUINAS: Array<[string, string]> = [
  [String.raw`(\d{1,2})[/.](\d{1,2})`, "g"],
  [String.raw`(?<dia>\d{1,2})/(?<mes>\d{1,2})(?:/(?<ano>\d{2,4}))?`, ""],
  [String.raw`(?<!\p{L})(hoje|amanh[ãa]|s[aá]bado)(?!\p{L})`, "iu"],
  [String.raw`(?<!\d[/.])\b(\d{1,2})[/.](\d{1,2})\b`, "gi"],
  [String.raw`\s+`, "g"],
  [String.raw`[^a-z0-9]+`, "gi"],
  [String.raw`[^a-z0-9 ]`, "g"],
  [String.raw`\p{Diacritic}`, "gu"],
  [String.raw`x*`, "g"],
  [String.raw``, "gu"],
  [String.raw`(a)|(b)`, "g"],
  [String.raw`(\w)\1`, "gi"],
  [String.raw`kas[iı]mpa[sş]a`, "i"],
  [String.raw`[a-z\u0100-\u017F]+`, "gi"],
  [String.raw`[a-zĀ-ſ]+`, "gi"],
  [String.raw`s|i|ᾀ|ᾈ|k`, "gi"],
  [String.raw`[a-z]+`, "y"],
  [String.raw`^\s*d[aeo]\s+(?:s[eé]rie|melhor)`, "im"],
  [String.raw`.`, "gs"],
  [String.raw`.`, "gsu"],
  [String.raw`(?:@|\b(?:odd?s?|cota(?:[cç][aã]o)?))\s*[:=\-]?\s*$`, "i"],
];

const TEXTOS = [
  "",
  "Flamengo x Palmeiras 27/09 às 16:00 @1.85",
  "📅 27/09 ⏰ 21h30 | Over 2.5 ✅",
  "hoje 21:30 — Sábado 16h, AMANHÃ às 9h",
  "Kasımpaşa x Beşiktaş · KASIMPAŞA ſ ı İ ᾀ ᾈ K",
  "São Paulo FC (Bra) – Atlético-MG u20",
  "aa bb Aa xx  \n  série 2/7 da melhor de 5",
  "1/2 x 3.4/5.6 x 2026/08/02 x 12/31/2026",
  "Odd: 2.11 cotação 1.90 preço=3",
  "a😀b\u{1F600}\u{1F4C5}c",
];

const TROCAS = ["-", "", "[$&]", "<$1|$2>", "$<dia>.$<mes>", "$`|$'", "$$", "$01$10$0"];

function v8Exec(source: string, flags: string, text: string, from: number): number[] | null {
  const regex = new RegExp(source, `${flags.replace(/[gyd]/g, "")}gd${flags.includes("y") ? "y" : ""}`);
  regex.lastIndex = from;
  const found = regex.exec(text);
  return found?.indices ? [...found.indices].flatMap((range) => range ?? [-1, -1]) : null;
}

function padroes(): Array<[string, string]> {
  const catalogo = servidor.regexCatalog();
  expect(navegador.regexCatalog()).toEqual(catalogo);
  return [...catalogo, ...QUINAS];
}

describe("regex do domínio: servidor e navegador dão o que o V8 dá", () => {
  it("busca a partir de cada posição", () => {
    for (const [source, flags] of padroes()) {
      for (const text of TEXTOS) {
        for (let from = 0; from <= text.length + 1; from++) {
          const esperado = v8Exec(source, flags, text, from);
          for (const [lado, dominio] of Object.entries(lados)) {
            expect(dominio.regexExec(source, flags, text, from), `${lado} /${source}/${flags} em ${JSON.stringify(text)} de ${from}`).toEqual(esperado);
          }
        }
      }
    }
  });

  it("troca e divisão", () => {
    for (const [source, flags] of padroes()) {
      for (const text of TEXTOS) {
        // O Rust só tem texto bem formado: meia unidade solta que o JS deixaria
        // (troca sem `u` que parte um emoji) sai U+FFFD, como no `toWellFormed()`.
        const divisao = text.split(new RegExp(source, flags)).map((piece) => (piece ?? "").toWellFormed());
        for (const [lado, dominio] of Object.entries(lados)) {
          const contexto = `${lado} /${source}/${flags} em ${JSON.stringify(text)}`;
          for (const troca of TROCAS) {
            expect(dominio.regexReplace(source, flags, text, troca), `${contexto} → ${troca}`).toBe(text.replace(new RegExp(source, flags), troca).toWellFormed());
          }
          expect(dominio.regexSplit(source, flags, text), contexto).toEqual(divisao);
          expect(dominio.regexSplit(source, flags, text, 2), `${contexto} limite 2`).toEqual(divisao.slice(0, 2));
        }
      }
    }
  });

  it("caixa sem u: cada caractere do BMP que muda de caixa casa os mesmos que no V8", () => {
    const cased = new Set<number>();
    for (let code = 0; code < 0x10000; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const char = String.fromCharCode(code);
      for (const other of [char, char.toUpperCase(), char.toLowerCase()]) {
        if (other !== char || other.toUpperCase() !== char || other.toLowerCase() !== char) {
          if (other.length === 1) cased.add(other.charCodeAt(0));
          cased.add(code);
        }
      }
    }
    const texto = String.fromCharCode(...[...cased].sort((a, b) => a - b));
    for (const flags of ["gi", "giu"]) {
      for (const code of cased) {
        const source = `\\u${code.toString(16).padStart(4, "0")}`;
        const esperado = texto.replace(new RegExp(source, flags), "\u0000");
        expect(servidor.regexReplace(source, flags, texto, "\u0000"), `/${source}/${flags}`).toBe(esperado);
      }
    }
  });
});
