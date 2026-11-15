#!/usr/bin/env node
/**
 * Compara o que está vivo no servidor com o que está versionado aqui.
 *
 * Sem esta comparação, um arquivo de deploy do servidor pode descrever uma
 * receita que não é a da imagem real, e quem o abrisse para entender a
 * produção entenderia errado. O verificador não conserta nada: aponta, e sai
 * com código 1 para travar um fluxo automatizado.
 *
 *   node scripts/check-deploy-drift.mjs            # compara e relata
 *   node scripts/check-deploy-drift.mjs --json     # saída para automação
 *
 * Fora do servidor de produção (CI, máquina local) ele não tem o que comparar
 * e sai com 0 dizendo isso — a ausência do alvo não é uma falha.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const VIVO = process.env.AUTOMABACA_DEPLOY_DIR || "/srv/apps/automabaca-novo/deploy";

/** Marcadores que a release substitui; comparar o texto cru acusaria falsa deriva. */
const PLACEHOLDERS = ["__RELEASE_ID__", "__RELEASE_SHA__", "__WEB_IMAGE__", "__WORKER_IMAGE__"];

/**
 * Um compose vivo difere do versionado exatamente pela release publicada.
 * Descobrimos qual é lendo o rótulo e reconstruímos o esperado a partir dela,
 * em vez de apagar as linhas dos dois lados — assim um segundo campo trocado à
 * mão continua aparecendo.
 */
export function renderCompose(template, { releaseId, releaseSha, webImage, workerImage }) {
  return template
    .replaceAll("__RELEASE_ID__", releaseId)
    .replaceAll("__RELEASE_SHA__", releaseSha)
    .replaceAll("__WEB_IMAGE__", webImage ?? "__WEB_IMAGE__")
    .replaceAll("__WORKER_IMAGE__", workerImage ?? "__WORKER_IMAGE__");
}

function imageFromLiveCompose(texto, role) {
  const pattern = new RegExp(`^\\s*image:\\s*(\\S*automabaca-novo-${role}(?::|@)\\S+)\\s*$`, "m");
  return texto.match(pattern)?.[1] ?? null;
}

export function releaseFromLiveCompose(texto) {
  const id = texto.match(/AUTOMABACA_RELEASE_ID:\s*(\S+)/)?.[1];
  const sha = texto.match(/AUTOMABACA_RELEASE_SHA:\s*(\S+)/)?.[1];
  return id && sha ? {
    releaseId: id,
    releaseSha: sha,
    webImage: imageFromLiveCompose(texto, "web"),
    workerImage: imageFromLiveCompose(texto, "worker"),
  } : null;
}

export function imageIsPinned(image) {
  return typeof image === "string" && /@sha256:[0-9a-f]{64}$/.test(image);
}

/** Comentário e linha em branco são ruído de leitura, não configuração. */
const significativo = (texto) => texto
  .split("\n")
  .map((linha) => linha.replace(/\s+$/, ""))
  .filter((linha) => linha.trim() !== "" && !linha.trim().startsWith("#"))
  .join("\n");

export function compararArquivo({ versionado, vivo, nome }) {
  if (vivo === ILEGIVEL) return { nome, estado: "ilegivel_sem_privilegio" };
  if (vivo === null) return { nome, estado: "ausente_no_servidor" };
  if (versionado === null) return { nome, estado: "ausente_no_repositorio" };
  return significativo(versionado) === significativo(vivo)
    ? { nome, estado: "igual" }
    : { nome, estado: "divergente" };
}

/** O compose vivo é 0600 do root: sem sudo não dá para afirmar nada sobre ele. */
export const ILEGIVEL = Symbol("ilegivel");

function ler(caminho) {
  if (!existsSync(caminho)) return null;
  try {
    return readFileSync(caminho, "utf8");
  } catch (erro) {
    if (erro.code === "EACCES") return ILEGIVEL;
    throw erro;
  }
}

function comparar() {
  const resultados = [];
  const composeVivo = ler(join(VIVO, "compose.yaml"));
  const composeTemplate = ler(join(REPO, "deploy", "compose.yaml"));
  if (typeof composeVivo === "string" && typeof composeTemplate === "string") {
    const release = releaseFromLiveCompose(composeVivo);
    if (!release) {
      resultados.push({ nome: "compose.yaml", estado: "sem_release_legivel" });
    } else {
      resultados.push(compararArquivo({
        nome: "compose.yaml", vivo: composeVivo, versionado: renderCompose(composeTemplate, release),
      }));
      if (!imageIsPinned(release.webImage) || !imageIsPinned(release.workerImage)) {
        resultados.push({ nome: "compose-images", estado: "imagens_sem_digest" });
      }
    }
  } else {
    resultados.push(compararArquivo({ nome: "compose.yaml", vivo: composeVivo, versionado: composeTemplate }));
  }

  for (const [nome, noRepo] of [
    ["Dockerfile.web", "Dockerfile.web"],
    ["Dockerfile.worker", "Dockerfile.worker"],
    ["split-env.cjs", "deploy/split-env.cjs"],
  ]) {
    resultados.push(compararArquivo({
      nome, vivo: ler(join(VIVO, nome)), versionado: ler(join(REPO, noRepo)),
    }));
  }
  return resultados;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!existsSync(VIVO)) {
    process.stdout.write(`Sem ${VIVO} nesta máquina — nada a comparar.\n`);
    process.exit(0);
  }
  const resultados = comparar();
  if (process.argv.includes("--json")) {
    process.stdout.write(JSON.stringify({ deployDir: VIVO, resultados }, null, 2) + "\n");
  } else {
    for (const { nome, estado } of resultados) {
      process.stdout.write(`${estado === "igual" ? "ok      " : "DERIVA  "} ${nome.padEnd(20)} ${estado}\n`);
    }
  }
  const problemas = resultados.filter((r) => r.estado !== "igual");
  if (problemas.length) {
    process.stderr.write(`\n${problemas.length} arquivo(s) fora de sincronia com o repositório.\n`);
    process.stderr.write("O que está no servidor não é o que está revisado. Reconcilie antes de publicar.\n");
    process.exit(1);
  }
  process.stdout.write("\nServidor e repositório dizem a mesma coisa.\n");
}

export { comparar, significativo, PLACEHOLDERS };
