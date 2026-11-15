// Lado do navegador da ponte: o mesmo crate em WebAssembly. O módulo é um
// arquivo estático (`.next/static/media`), baixado comprimido e compilado em
// streaming; o `await` no topo faz a tela esperar por ele antes de hidratar,
// e as funções do domínio continuam síncronas para quem as chama. Exige
// 'wasm-unsafe-eval' no script-src da CSP.
import * as cola from "./wasm/dominio_ponte.mjs";

await cola.default({ module_or_path: new URL("./wasm/dominio_ponte_bg.wasm", import.meta.url) });
// Fora o que é da cola (as duas cargas); o resto são as funções da ponte.
const { default: _carregarAssincrono, initSync: _carregarSincrono, ...funcoes } = cola;

export default Object.freeze(funcoes);
