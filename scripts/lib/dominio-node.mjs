import { createRequire } from "node:module";
import path from "node:path";

/** O pacote da ponte N-API e o binário que `scripts/build-dominio-node.mjs` gera nele. */
export const DOMINIO_NODE_PACOTE = "@automabaca/dominio-node";
export const DOMINIO_NODE_DIR = "rust/crates/dominio-node";
export const DOMINIO_NODE_BINARIO = `${DOMINIO_NODE_DIR}/dominio-node.linux-x64-gnu.node`;
/** Arquivos do pacote que viajam no runtime (o `files` do package.json dele). */
export const DOMINIO_NODE_ARQUIVOS = ["package.json", "index.cjs", "index.d.ts", path.basename(DOMINIO_NODE_BINARIO)];

/**
 * Carrega a ponte como o runtime em `raiz` a carregaria e confere que ela
 * respondeu dali, não do node_modules do checkout acima.
 */
export function carregarDominioNode(raiz) {
  const require = createRequire(path.join(raiz, "package.json"));
  const caminho = require.resolve(DOMINIO_NODE_PACOTE);
  if (!caminho.startsWith(`${path.resolve(raiz)}${path.sep}`)) {
    throw new Error(`${DOMINIO_NODE_PACOTE} resolvido fora de ${raiz}: ${caminho}`);
  }
  const versao = require(DOMINIO_NODE_PACOTE).versao();
  if (!/^\d+\.\d+\.\d+$/.test(versao)) throw new Error(`${DOMINIO_NODE_PACOTE} respondeu versão inválida: ${versao}`);
  return { caminho, versao };
}

/**
 * As cópias do binário dentro do runtime.tar.gz: a do standalone (web) e a do
 * pacote do worker. O manifesto da release confere as duas contra o binário
 * que o job `rust` compilou e testou.
 */
export const DOMINIO_NODE_NO_RUNTIME = [".next/standalone", "dist/worker-runtime"]
  .map((pasta) => `${pasta}/node_modules/${DOMINIO_NODE_PACOTE}/${path.basename(DOMINIO_NODE_BINARIO)}`);
