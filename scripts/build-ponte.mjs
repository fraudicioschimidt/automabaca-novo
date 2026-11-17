/**
 * Compila a ponte Rust (`rust/crates/ponte`) para os dois lados e põe o
 * resultado no pacote `@automabaca/dominio`, onde web, worker, navegador e
 * testes o acham:
 *
 * - N-API: `dominio.linux-x64-gnu.node`. Tem de carregar nas imagens (Debian
 *   bookworm, glibc 2.36): binário que peça glibc mais nova é recusado aqui,
 *   em vez de o worker só cair na produção.
 * - WebAssembly: `wasm/dominio_ponte_bg.wasm` e `wasm/dominio_ponte.mjs` (a
 *   cola do `wasm-bindgen`, na mesma versão do crate). O navegador baixa o
 *   .wasm como arquivo estático (ver browser.mjs).
 *
 * Os dois saem sem caminho da máquina que compilou (pasta do cargo, do
 * repositório): o mesmo commit dá o mesmo .wasm aqui e na CI.
 *
 *   node scripts/build-ponte.mjs              compila e instala no node_modules
 *   node scripts/build-ponte.mjs --instalar   só instala (binários do artefato `ci-rust`)
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import path from "node:path";
import { sha256 } from "./lib/release-provenance.mjs";
import { instalarPonteNoNodeModules, PONTE_BINARIO, PONTE_DIR, PONTE_WASM } from "./lib/ponte.mjs";

const GLIBC_DAS_IMAGENS = [2, 36];
const root = fileURLToPath(new URL("..", import.meta.url));
const rust = path.join(root, "rust");
const cargoHome = process.env.CARGO_HOME ?? path.join(homedir(), ".cargo");

// O rustc grava o caminho do fonte nas mensagens de pânico (as do num-bigint,
// por exemplo): sem o remapeamento, o sha muda com a pasta de quem compila.
// Só o build de release da ponte usa estas flags, então o cache do clippy e
// dos testes não é invalidado.
const RUSTFLAGS = [process.env.RUSTFLAGS, `--remap-path-prefix=${cargoHome}=/cargo`,
  `--remap-path-prefix=${rust}=/automabaca/rust`].filter(Boolean).join(" ");

function run(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: rust, stdio: "inherit", env: { ...process.env, ...env } });
  if (result.error) throw new Error(`${command} indisponível: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} falhou (${result.status}).`);
}

function compilarNode() {
  run("cargo", ["build", "--release", "--locked", "-p", "dominio-ponte"], { RUSTFLAGS });
  const destino = path.join(root, PONTE_BINARIO);
  copyFileSync(path.join(rust, "target/release/libdominio_ponte.so"), destino);
  recusarCaminhoDaMaquina(destino);
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
}

function compilarWasm() {
  // A cola JS e o crate têm de ser da mesma versão, ou o binário não casa com ela.
  const lock = readFileSync(path.join(rust, "Cargo.lock"), "utf8");
  const versao = /\[\[package\]\]\nname = "wasm-bindgen"\nversion = "([^"]+)"/.exec(lock)?.[1];
  const cli = spawnSync("wasm-bindgen", ["--version"], { encoding: "utf8" });
  const instalada = cli.stdout?.trim().split(" ")[1];
  if (!versao || instalada !== versao) {
    throw new Error(`wasm-bindgen ${instalada ?? "ausente"}; o Cargo.lock pede ${versao}. Instale: cargo install wasm-bindgen-cli --version ${versao} --locked`);
  }
  // O WebAssembly viaja para o navegador em cada tela que usa a ponte: otimizado
  // para tamanho (−11% contra o padrão), sem mexer no binário do servidor.
  run("cargo", ["build", "--release", "--locked", "-p", "dominio-ponte", "--target", "wasm32-unknown-unknown"],
    { CARGO_PROFILE_RELEASE_OPT_LEVEL: "s", RUSTFLAGS });
  const saida = path.join(root, PONTE_DIR, "wasm");
  mkdirSync(saida, { recursive: true });
  // `--weak-refs`: o objeto Rust de uma classe da ponte (o acumulador) é
  // liberado quando o JavaScript o descarta, sem `free()` à mão. Os nomes de
  // função (a seção `name`, um oitavo do arquivo) só serviriam ao depurador.
  run("wasm-bindgen", ["--target", "web", "--no-typescript", "--weak-refs", "--remove-name-section",
    "--remove-producers-section", "--out-dir", saida, "--out-name", "dominio_ponte",
    path.join(rust, "target/wasm32-unknown-unknown/release/dominio_ponte.wasm")]);
  // A cola acharia o .wasm por conta própria (`new URL(..., import.meta.url)`);
  // o browser.mjs passa o endereço, e uma referência só faz o bundler publicar
  // um arquivo só. A cola é ESM: `.mjs`, para o Node não ter de adivinhar.
  const gerada = path.join(saida, "dominio_ponte.js");
  const texto = readFileSync(gerada, "utf8");
  const referencia = "new URL('dominio_ponte_bg.wasm', import.meta.url)";
  if (texto.split(referencia).length !== 2) throw new Error(`cola do wasm-bindgen mudou: sem ${referencia}`);
  writeFileSync(path.join(saida, "dominio_ponte.mjs"), embutirSnippets(saida, texto.replace(referencia, "undefined")));
  rmSync(gerada);
  rmSync(path.join(saida, "bytes.mjs"), { force: true });
  recusarCaminhoDaMaquina(path.join(root, PONTE_WASM));
}

// JS que um crate embute (`inline_js`, o RegExp do host no js-regex) sai em
// `snippets/`, importado pela cola: vai para dentro dela, e o pacote continua
// com dois arquivos de WebAssembly.
function embutirSnippets(saida, cola) {
  const importacao = /^import \{[^}]*\} from '\.\/(snippets\/[^']+\.js)';\n/gm;
  const comSnippets = cola.replace(importacao, (_linha, relativo) =>
    `${readFileSync(path.join(saida, relativo), "utf8").replace(/^export function /gm, "function ")}\n`);
  if (comSnippets.includes("snippets/")) throw new Error("cola do wasm-bindgen com import de snippet que o build não embutiu");
  rmSync(path.join(saida, "snippets"), { recursive: true, force: true });
  return comSnippets;
}

function recusarCaminhoDaMaquina(arquivo) {
  const bytes = readFileSync(arquivo);
  const vazados = [cargoHome, root, homedir()].filter((caminho) => bytes.includes(caminho));
  if (vazados.length > 0) {
    throw new Error(`${path.relative(root, arquivo)} guarda caminho desta máquina (${vazados.join(", ")}): o sha não bateria com o da CI`);
  }
}

if (!process.argv.includes("--instalar")) {
  compilarNode();
  compilarWasm();
}
const instalacao = instalarPonteNoNodeModules(root);
for (const arquivo of [PONTE_BINARIO, PONTE_WASM]) {
  process.stdout.write(`${arquivo} (sha256 ${sha256(readFileSync(path.join(root, arquivo)))})\n`);
}
process.stdout.write(instalacao.instalado ? `${instalacao.destino} atualizado\n` : `node_modules não atualizado: ${instalacao.motivo}\n`);
