/**
 * Compila a ponte N-API (`rust/crates/dominio-node`) e põe o binário ao lado
 * do carregador do pacote `@automabaca/dominio-node`, onde web, worker e testes
 * o acham.
 *
 *   node scripts/build-dominio-node.mjs
 *
 * O binário tem de carregar nas imagens (Debian bookworm, glibc 2.36): a
 * conferência abaixo recusa o que pedir uma glibc mais nova que essa, em vez
 * de o worker só cair na produção.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { sha256 } from "./lib/release-provenance.mjs";
import { DOMINIO_NODE_BINARIO } from "./lib/dominio-node.mjs";

const GLIBC_DAS_IMAGENS = [2, 36];

const root = fileURLToPath(new URL("..", import.meta.url));
const cargo = spawnSync("cargo", ["build", "--release", "--locked", "-p", "dominio-node"], {
  cwd: path.join(root, "rust"), stdio: "inherit",
});
if (cargo.error) throw cargo.error;
if (cargo.status !== 0) throw new Error(`cargo build falhou (${cargo.status}).`);

const origem = path.join(root, "rust/target/release/libdominio_node.so");
const destino = path.join(root, DOMINIO_NODE_BINARIO);
copyFileSync(origem, destino);

// As versões de símbolo GLIBC_x.y que o binário exige, lidas do próprio ELF
// (tabela .gnu.version_r): sem depender de objdump/readelf na máquina.
const versoes = [...new Set(readFileSync(destino).toString("latin1").match(/GLIBC_\d+\.\d+(?:\.\d+)?/g) ?? [])];
const acima = versoes.filter((versao) => {
  const [maior, menor] = versao.slice("GLIBC_".length).split(".").map(Number);
  return maior > GLIBC_DAS_IMAGENS[0] || (maior === GLIBC_DAS_IMAGENS[0] && menor > GLIBC_DAS_IMAGENS[1]);
});
if (acima.length > 0) {
  throw new Error(`Binário exige glibc mais nova que a das imagens (${GLIBC_DAS_IMAGENS.join(".")}): ${acima.join(", ")}`);
}
process.stdout.write(`${DOMINIO_NODE_BINARIO} (sha256 ${sha256(readFileSync(destino))})\n`);
