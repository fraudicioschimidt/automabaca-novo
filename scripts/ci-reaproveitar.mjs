// Num push na `main`, decide se as verificações que o PR já passou valem para
// este commit — e, se valem, a main pula `verificações` e a metade de navegador
// de `build e navegador`, indo direto ao build → release → imagens.
//
// Só diz "sim" com prova, e qualquer dúvida (API falhou, mais de um PR, PR sem
// execução verde, artefatos expirados, fonte diferente) vira "não":
// a main roda tudo, como antes.
//
// A prova é o conteúdo. Um PR roda sobre o commit de teste `refs/pull/N/merge`
// (o PR mesclado na main DAQUELE momento), e cada registro guarda esse commit e
// o SHA-256 do fonte (`scripts/record-check.mjs`). Reaproveita só se a árvore
// do commit testado for idêntica à deste push E o SHA-256 bater com o deste
// checkout — o mesmo que o `write-release-manifest`/`verify-release` exigem.
// Se a main andou entre a execução do PR e o merge, a árvore difere e roda tudo.
//
// Saídas (GITHUB_OUTPUT): reuse=true|false, run=<id da execução do PR>,
// commit=<commit testado>, pr=<número>.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSnapshot } from "./lib/release-provenance.mjs";

const REPO = process.env.GITHUB_REPOSITORY;
const SHA = process.env.GITHUB_SHA;
// Registro (record-check) → nome do job que o produz no check.yml.
const REAPROVEITADAS = { static: "verificações", database: "verificações", browser: "build e navegador" };
// Artefatos do check.yml que trazem esses registros.
const ARTEFATOS = ["ci-verificacoes", "ci-navegador"];

function saida(campos) {
  const linhas = Object.entries(campos).map(([chave, valor]) => `${chave}=${valor}`).join("\n") + "\n";
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, linhas);
  process.stdout.write(linhas);
}

function nao(motivo) {
  process.stdout.write(`::notice title=Main roda tudo::${motivo}\n`);
  saida({ reuse: "false" });
  process.exit(0);
}

function api(caminho) {
  return JSON.parse(execFileSync("gh", ["api", caminho], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

function arvore(commit) {
  return api(`repos/${REPO}/git/commits/${commit}`).tree.sha;
}

try {
  if (process.env.GITHUB_EVENT_NAME !== "push" || process.env.GITHUB_REF !== "refs/heads/main") {
    nao("não é push na main");
  }
  if (!REPO || !/^[0-9a-f]{40}$/.test(SHA ?? "")) nao("GITHUB_REPOSITORY/GITHUB_SHA ausentes");

  const prs = api(`repos/${REPO}/commits/${SHA}/pulls`)
    .filter((pr) => pr.merged_at && pr.merge_commit_sha === SHA && pr.base?.ref === "main");
  if (prs.length !== 1) nao(`${prs.length} PR(s) mesclados com merge_commit_sha = ${SHA}`);
  const pr = prs[0];

  const execucoes = api(`repos/${REPO}/actions/workflows/check.yml/runs?event=pull_request&head_sha=${pr.head.sha}&per_page=20`)
    .workflow_runs.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const execucao = execucoes[0];
  if (!execucao || execucao.status !== "completed" || execucao.conclusion !== "success") {
    nao(`a última execução do check no PR #${pr.number} (${pr.head.sha.slice(0, 7)}) não está concluída com sucesso`);
  }
  const jobs = api(`repos/${REPO}/actions/runs/${execucao.id}/jobs?per_page=100`).jobs;
  for (const nome of new Set(Object.values(REAPROVEITADAS))) {
    const job = jobs.find((item) => item.name === nome);
    if (job?.conclusion !== "success") nao(`job "${nome}" da execução ${execucao.id} não está verde`);
  }

  // Os registros são artefatos da execução do PR (`ci-verificacoes` e
  // `ci-navegador`, 7 dias no check.yml); a `release verificada` baixa os mesmos.
  const pasta = mkdtempSync(join(tmpdir(), "reaproveitar-"));
  const arquivos = Object.keys(REAPROVEITADAS).map((nome) => `${nome}.json`);
  try {
    for (const artefato of ARTEFATOS) {
      execFileSync("gh", ["run", "download", String(execucao.id), "-R", REPO, "-n", artefato, "-D", pasta], { stdio: "pipe" });
    }
  } catch {
    nao(`artefatos da execução ${execucao.id} não estão mais disponíveis`);
  }
  const registros = arquivos.map((arquivo) => JSON.parse(readFileSync(join(pasta, arquivo), "utf8")));

  const aqui = sourceSnapshot();
  const testado = registros[0].source.commit;
  for (const registro of registros) {
    if (registro.exitCode !== 0) nao(`registro ${registro.name} reprovado`);
    if (registro.source.commit !== testado) nao("registros de commits diferentes na mesma execução");
    if (registro.source.sourceSha256 !== aqui.sourceSha256) nao(`fonte de ${registro.name} difere deste commit`);
  }
  if (aqui.dirty) nao("checkout sujo");
  if (arvore(testado) !== arvore(SHA)) nao(`a árvore testada no PR (${testado.slice(0, 7)}) difere da deste commit: a main andou antes do merge`);

  process.stdout.write(`::notice title=Verificações do PR reaproveitadas::PR #${pr.number}, execução ${execucao.id}, commit testado ${testado}\n`);
  saida({ reuse: "true", run: String(execucao.id), commit: testado, pr: String(pr.number) });
} catch (erro) {
  nao(`erro ao decidir (${erro instanceof Error ? erro.message.split("\n")[0] : String(erro)})`);
}
