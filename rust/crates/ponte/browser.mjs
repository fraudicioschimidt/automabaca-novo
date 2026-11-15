// Lado do navegador da ponte: o mesmo crate em WebAssembly, compilado de forma
// síncrona na carga do módulo, porque as funções do domínio são chamadas
// durante a renderização. Exige 'wasm-unsafe-eval' no script-src da CSP.
import * as cola from "./wasm/dominio_ponte.mjs";
import bytes from "./wasm/bytes.mjs";

cola.initSync({ module: Uint8Array.from(atob(bytes), (caractere) => caractere.charCodeAt(0)) });
const { default: _carregarAssincrono, initSync: _carregarSincrono, ...funcoes } = cola;

export default Object.freeze(funcoes);
