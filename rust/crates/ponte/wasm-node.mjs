// O lado do navegador carregado no Node, para os testes (`DOMINIO_PONTE=wasm`
// e tests/plataforma/ponte.test.ts): o mesmo .wasm e a mesma cola que o
// browser.mjs, lidos do disco em vez de baixados.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cola from "./wasm/dominio_ponte.mjs";

// Caminho montado à mão: nos testes de tela (jsdom), o Vite reescreve
// `new URL("./x", import.meta.url)` como endereço de asset da web.
const pasta = path.dirname(fileURLToPath(import.meta.url));
cola.initSync({ module: readFileSync(path.join(pasta, "wasm", "dominio_ponte_bg.wasm")) });
const { default: _carregarAssincrono, initSync: _carregarSincrono, ...funcoes } = cola;

export default Object.freeze(funcoes);
