#!/usr/bin/env node
/**
 * Monta os contextos de build das imagens web e worker a partir do artefato
 * verificado da CI. Uma definição só, usada pela CI e pelo preparo da release.
 *
 * Se a CI e o servidor montassem as camadas por conta própria, as duas receitas
 * divergiriam, e o servidor passaria a construir uma imagem que a CI não
 * verificou.
 *
 *   node scripts/montar-camadas-de-imagem.mjs --artifact <dir> --out <dir>
 *
 * Produz <out>/web-layer e <out>/worker-layer, mais <out>/ops-provenance.json.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_PADRAO = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Comandos operacionais que viajam na imagem do worker: todo `scripts/ops-*.ts`
 * do repositório. O build:worker compila a mesma lista, então um comando novo
 * não depende de ninguém lembrar de acrescentá-lo em lugar nenhum.
 */
export function comandosOperacionais(repo = REPO_PADRAO) {
  return readdirSync(join(repo, "scripts"))
    .filter((nome) => /^ops-[a-z0-9-]+\.ts$/.test(nome))
    .map((nome) => nome.slice(0, -".ts".length))
    .sort();
}

function argumento(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

/**
 * Cada dependência externa dos bundles operacionais tem de resolver DENTRO da
 * camada do worker. Sem esta conferência, o `ops-settle` só quebraria na hora
 * em que alguém precisasse dele para liquidar uma aposta à mão.
 */
function conferirDependencias(workerLayer, meta) {
  for (const saida of Object.values(meta.outputs)) {
    for (const item of saida.imports) {
      const dep = item.path;
      if (!item.external || dep.startsWith("node:")) continue;
      execFileSync("node", ["--input-type=module", "-e",
        'import { createRequire, isBuiltin } from "node:module"; const dep=process.argv[1]; '
        + 'if (!isBuiltin(dep)) createRequire(process.cwd()+"/package.json").resolve(dep);', dep],
      { cwd: workerLayer, stdio: "pipe" });
    }
  }
}

export function montarCamadas({ artifact, out, repo = REPO_PADRAO, sha }) {
  const runtime = join(out, "verified-runtime");
  mkdirSync(runtime, { recursive: true });
  execFileSync("tar", ["-xzf", join(artifact, "runtime.tar.gz"), "-C", runtime]);

  const web = join(out, "web-layer");
  const worker = join(out, "worker-layer");
  cpSync(join(runtime, ".next/standalone"), web, { recursive: true, verbatimSymlinks: true });
  cpSync(join(runtime, "dist/worker-runtime"), worker, { recursive: true, verbatimSymlinks: true });

  // Os bundles operacionais saem do MESMO commit que a release, compilados aqui.
  execFileSync("npm", ["run", "build:worker"], { cwd: repo, stdio: "pipe" });
  const provenance = { sourceCommit: sha, command: "npm run build:worker", bundles: {} };
  for (const nome of comandosOperacionais(repo)) {
    const meta = JSON.parse(readFileSync(join(repo, `dist/${nome}.meta.json`), "utf8"));
    conferirDependencias(worker, meta);
    const bundle = join(repo, `dist/${nome}.mjs`);
    cpSync(bundle, join(worker, `dist/${nome}.mjs`));
    provenance.bundles[nome] = createHash("sha256").update(readFileSync(bundle)).digest("hex");
  }

  // `src/` e `prisma/` vêm do git no commit publicado, não da árvore de trabalho:
  // uma edição não commitada não pode entrar numa imagem de produção.
  execFileSync("bash", ["-c", `git archive ${sha} src prisma | tar -x -C ${JSON.stringify(worker)}`], { cwd: repo });

  const texto = JSON.stringify(provenance, null, 2) + "\n";
  writeFileSync(join(out, "ops-provenance.json"), texto);
  writeFileSync(join(worker, "ops-provenance.json"), texto);
  return { web, worker, provenance };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const artifact = resolve(argumento("artifact", "artifact"));
  const out = resolve(argumento("out", "camadas"));
  const repo = resolve(argumento("repo", REPO_PADRAO));
  const manifest = JSON.parse(readFileSync(join(artifact, "release-manifest.json"), "utf8"));
  const sha = manifest.source.commit;

  const cabeca = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  if (cabeca !== sha) {
    process.stderr.write(`HEAD (${cabeca}) não é o commit do artefato (${sha}).\n`);
    process.exit(1);
  }
  if (existsSync(join(out, "worker-layer"))) {
    process.stderr.write(`${out} já tem camadas montadas; use um diretório limpo.\n`);
    process.exit(1);
  }
  mkdirSync(out, { recursive: true });
  const { provenance } = montarCamadas({ artifact, out, repo, sha });
  process.stdout.write(JSON.stringify({ montado: true, out, commit: sha, bundles: provenance.bundles }, null, 2) + "\n");
}
