import { createRequire } from "node:module";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import path from "node:path";
import { safeRemoveTreeSync } from "./safe-fs.mjs";

/**
 * A ponte Rust (`rust/crates/ponte`, pacote `@automabaca/dominio`): o binário
 * N-API para os processos Node e o WebAssembly para o navegador, que o
 * `scripts/build-ponte.mjs` gera dentro do pacote.
 */
export const PONTE_PACOTE = "@automabaca/dominio";
export const PONTE_DIR = "rust/crates/ponte";
export const PONTE_BINARIO = `${PONTE_DIR}/dominio.linux-x64-gnu.node`;
export const PONTE_WASM = `${PONTE_DIR}/wasm/dominio_ponte_bg.wasm`;
/** O que web e worker carregam no servidor: só o lado N-API. */
export const PONTE_ARQUIVOS = ["package.json", "index.cjs", "index.d.ts", path.basename(PONTE_BINARIO)];
/** O pacote inteiro, com o lado do navegador, como o build do Next o resolve. */
const PONTE_ARQUIVOS_COM_NAVEGADOR = [...PONTE_ARQUIVOS, "browser.mjs", "wasm/dominio_ponte.mjs", "wasm/dominio_ponte_bg.wasm"];

/**
 * Carrega a ponte como o runtime em `raiz` a carregaria e confere que ela
 * respondeu dali, não do node_modules do checkout acima.
 */
export function carregarPonte(raiz) {
  const require = createRequire(path.join(raiz, "package.json"));
  const caminho = require.resolve(PONTE_PACOTE);
  if (!caminho.startsWith(`${path.resolve(raiz)}${path.sep}`)) {
    throw new Error(`${PONTE_PACOTE} resolvido fora de ${raiz}: ${caminho}`);
  }
  const versao = require(PONTE_PACOTE).versao();
  if (!/^\d+\.\d+\.\d+$/.test(versao)) throw new Error(`${PONTE_PACOTE} respondeu versão inválida: ${versao}`);
  return { caminho, versao };
}

/**
 * Põe o pacote como pasta real em `node_modules`. O `file:` do npm cria um
 * link para `rust/`, e o Turbopack segue o caminho real: fora de
 * `node_modules`, o SSR de componente de cliente deixa de tratar a ponte como
 * externa e tenta empacotar o `.node`. Numa worktree com o node_modules da
 * árvore principal, não mexe (seria o da principal).
 */
export function instalarPonteNoNodeModules(raiz) {
  const modulos = path.join(raiz, "node_modules");
  if (!existsSync(modulos)) return { instalado: false, motivo: "sem node_modules" };
  if (!realpathSync(modulos).startsWith(`${realpathSync(raiz)}${path.sep}`)) {
    return { instalado: false, motivo: "node_modules é o da árvore principal (worktree sem `worktree.sh build`)" };
  }
  const destino = path.join(modulos, PONTE_PACOTE);
  // O link do npm sai sem tocar no alvo; a pasta de uma instalação anterior, inteira.
  if (lstatSync(destino, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(destino);
  else safeRemoveTreeSync(raiz, destino);
  for (const arquivo of PONTE_ARQUIVOS_COM_NAVEGADOR) {
    if (!existsSync(path.join(raiz, PONTE_DIR, arquivo))) {
      throw new Error(`Ponte Rust sem ${PONTE_DIR}/${arquivo}: rode \`npm run build:ponte\`.`);
    }
  }
  for (const arquivo of PONTE_ARQUIVOS_COM_NAVEGADOR) {
    mkdirSync(path.dirname(path.join(destino, arquivo)), { recursive: true });
    cpSync(path.join(raiz, PONTE_DIR, arquivo), path.join(destino, arquivo));
  }
  return { instalado: true, destino };
}

/** O build e o dev do Next só funcionam com a pasta real que a função acima instala. */
export function conferirPonteInstalada(raiz) {
  const destino = path.join(raiz, "node_modules", PONTE_PACOTE);
  const estado = lstatSync(destino, { throwIfNoEntry: false });
  if (!estado?.isDirectory() || !existsSync(path.join(destino, path.basename(PONTE_BINARIO)))) {
    throw new Error(`${PONTE_PACOTE} em node_modules ${estado?.isSymbolicLink() ? "é o link do npm" : "está ausente ou sem o binário"}: `
      + "rode `npm run build:ponte`. O SSR do Next só trata a ponte como externa numa pasta real.");
  }
}

/**
 * As cópias do binário dentro do runtime.tar.gz: a do standalone (web) e a do
 * pacote do worker. O manifesto da release confere as duas contra o binário
 * que o job `rust` compilou e testou.
 */
export const PONTE_NO_RUNTIME = [".next/standalone", "dist/worker-runtime"]
  .map((pasta) => `${pasta}/node_modules/${PONTE_PACOTE}/${path.basename(PONTE_BINARIO)}`);

/** Onde o build do Next publica os arquivos estáticos, dentro do standalone. */
export const PONTE_ESTATICOS_DO_NAVEGADOR = ".next/standalone/.next/static";

/**
 * O WebAssembly da ponte que o build publicou para o navegador: um arquivo
 * `.wasm` só, com hash no nome. Mais de um, ou nenhum, é build errado.
 */
export function wasmPublicado(raiz = ".") {
  const pasta = path.join(raiz, PONTE_ESTATICOS_DO_NAVEGADOR);
  const encontrados = readdirSync(pasta, { recursive: true, encoding: "utf8" })
    .filter((nome) => nome.endsWith(".wasm"))
    .map((nome) => `${PONTE_ESTATICOS_DO_NAVEGADOR}/${nome.replaceAll("\\", "/")}`);
  if (encontrados.length !== 1) {
    throw new Error(`O navegador devia receber um .wasm da ponte Rust; o build publicou ${encontrados.length}: ${encontrados.join(", ")}`);
  }
  return encontrados[0];
}
