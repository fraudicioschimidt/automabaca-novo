/**
 * Veredito de cada release: aponta o erro de fila que nunca tinha aparecido e
 * apareceu junto com ela. Com poucas apostas por dia, taxa de erro por release
 * seria ruído; a impressão digital nova com um mínimo de ocorrências não é.
 * O veredito diz "apareceu junto com", nunca "causado por": um fornecedor que
 * muda a API dá o mesmo sinal.
 */

import { classifyDlqError, extractDlqErrorPayload, isDatabaseFailure } from "@/src/domain/dlq-classification";
import { classificaCausa, type CausaDeFalha } from "@/src/domain/falha-de-job";

/** Quanto tempo depois de a release ficar pronta os erros ainda contam para ela. */
export const RELEASE_OBSERVATION_MINUTES = 45;
/**
 * Tentativas com o mesmo erro novo para apontar. Uma só é o soluço que a
 * retentativa resolve; três já é o job repetindo a mesma falha.
 */
export const RELEASE_ERROR_MIN_OCCURRENCES = 3;

const REPOSITORY_URL = "https://github.com/fraudicioschimidt/automabaca-novo";
const PUBLISHED_SHA = /^[0-9a-f]{40}$/;

export type ReleaseVerdictKind = "sem_erro_novo" | "erro_novo";

/** Uma release que ficou pronta em produção, como o boot do worker a registrou. */
export type ReleaseRecord = {
  releaseId: string;
  sha: string;
  bootedAt: Date;
  readyAt: Date;
  previousSha: string | null;
};

/** Uma tentativa de job que falhou, já com a impressão digital do erro. */
export type ReleaseErrorOccurrence = {
  /** Fila + impressão digital da mensagem: a chave de "já visto". */
  fingerprint: string;
  queue: string;
  /** O que o dono lê: nome do erro e mensagem normalizada. */
  text: string;
  /** Release que rodava a tentativa (rótulo da métrica). */
  releaseId: string | null;
  jobId: string | null;
  occurredAt: Date;
};

export type ReleaseFinding = {
  fingerprint: string;
  queue: string;
  text: string;
  occurrences: number;
  jobs: number;
  firstAt: Date;
};

export type ReleaseJudgement = {
  verdict: ReleaseVerdictKind;
  findings: ReleaseFinding[];
  /**
   * Erros novos que não chegaram ao mínimo. Não apontam, mas entram em `seen`
   * e passam a ser conhecidos: gravados no veredito, continuam à vista.
   */
  belowThreshold: ReleaseFinding[];
  /** Impressões digitais que a própria release produziu: passam a ser conhecidas. */
  seen: string[];
  /** Tentativas da release que falharam com erro já conhecido. */
  knownErrors: number;
};

/** Só commit da main publicado vira release; "development" e afins ficam de fora. */
export function isPublishedSha(sha: string | null | undefined): sha is string {
  return typeof sha === "string" && PUBLISHED_SHA.test(sha);
}

export function observationEndOf(release: Pick<ReleaseRecord, "readyAt">): Date {
  return new Date(release.readyAt.getTime() + RELEASE_OBSERVATION_MINUTES * 60_000);
}

/**
 * Causas que vêm de fora ou do próprio deploy: circuito aberto, fornecedor que
 * não respondeu e o worker saindo no meio. A espera passageira de fornecedor
 * é a mesma que o worker já não conta como erro da fila; falha do banco conta.
 */
const EXTERNAL_CAUSES: ReadonlySet<CausaDeFalha> = new Set(["circuito_aberto", "provider_fora", "worker_saiu"]);

/** O erro gravado no job (`output` do pg-boss) pode ser atribuído a uma release? */
export function countsAsReleaseError(output: unknown): boolean {
  if (EXTERNAL_CAUSES.has(classificaCausa(output))) return false;
  const payload = extractDlqErrorPayload(output);
  if (!payload.message) return false;
  return classifyDlqError(payload) !== "transient" || isDatabaseFailure(payload);
}

/**
 * Julga a release pelas falhas da observação dela ([boot, pronta + 45 min]).
 * O erro é novo quando a release o produziu e ele não está em `known`; a
 * contagem inclui as tentativas da release seguinte dentro da observação,
 * porque a release que durou 3 minutos entrega o mesmo código à seguinte.
 */
export function judgeRelease(input: {
  releaseId: string;
  occurrences: readonly ReleaseErrorOccurrence[];
  known: ReadonlySet<string>;
  minOccurrences?: number;
}): ReleaseJudgement {
  const minOccurrences = input.minOccurrences ?? RELEASE_ERROR_MIN_OCCURRENCES;
  const own = input.occurrences.filter((occurrence) => occurrence.releaseId === input.releaseId);
  const seen = [...new Set(own.map((occurrence) => occurrence.fingerprint))];
  const fresh = new Set(seen.filter((fingerprint) => !input.known.has(fingerprint)));

  const groups = new Map<string, ReleaseErrorOccurrence[]>();
  for (const occurrence of input.occurrences) {
    if (!fresh.has(occurrence.fingerprint)) continue;
    const group = groups.get(occurrence.fingerprint);
    if (group) group.push(occurrence);
    else groups.set(occurrence.fingerprint, [occurrence]);
  }
  const candidates = [...groups.values()]
    .map((group): ReleaseFinding => {
      const first = group.reduce((a, b) => (b.occurredAt < a.occurredAt ? b : a));
      // Tentativa sem job conhecido conta como um job próprio.
      const jobs = new Set(group.map((occurrence, index) => occurrence.jobId ?? `sem-job:${index}`));
      return {
        fingerprint: first.fingerprint,
        queue: first.queue,
        text: first.text,
        occurrences: group.length,
        jobs: jobs.size,
        firstAt: first.occurredAt,
      };
    })
    .sort((a, b) => b.occurrences - a.occurrences || a.firstAt.getTime() - b.firstAt.getTime());
  const findings = candidates.filter((finding) => finding.occurrences >= minOccurrences);

  return {
    verdict: findings.length > 0 ? "erro_novo" : "sem_erro_novo",
    findings,
    belowThreshold: candidates.filter((finding) => finding.occurrences < minOccurrences),
    seen,
    knownErrors: own.filter((occurrence) => !fresh.has(occurrence.fingerprint)).length,
  };
}

export function releaseCommitUrl(sha: string): string {
  return `${REPOSITORY_URL}/commit/${sha}`;
}

/** As mudanças desde a release anterior; sem anterior conhecida, não há comparação. */
export function releaseCompareUrl(previousSha: string | null, sha: string): string | null {
  if (!isPublishedSha(previousSha) || previousSha === sha) return null;
  return `${REPOSITORY_URL}/compare/${previousSha}...${sha}`;
}

const MESSAGE_FINDINGS = 5;

/** O aviso do Telegram de uma release com erro novo. */
export function releaseVerdictMessage(
  release: Pick<ReleaseRecord, "releaseId" | "sha" | "previousSha">,
  findings: readonly Pick<ReleaseFinding, "queue" | "text" | "occurrences" | "jobs">[],
): string {
  const lines = findings.slice(0, MESSAGE_FINDINGS).map((finding) => (
    `• ${finding.queue} — ${finding.text}: ${finding.occurrences}× em ${finding.jobs} ${finding.jobs === 1 ? "job" : "jobs"}`
  ));
  if (findings.length > MESSAGE_FINDINGS) lines.push(`… e mais ${findings.length - MESSAGE_FINDINGS}.`);
  const compare = releaseCompareUrl(release.previousSha, release.sha);
  return [
    `🔎 Erro novo junto com a release ${release.releaseId}`,
    ...lines,
    "Nenhum deles aparece no histórico de erros de antes desta release. Apareceram junto com ela, "
      + "o que não prova que ela é a causa: um fornecedor que mudou dá o mesmo sinal.",
    `Commit (o GitHub mostra o PR): ${releaseCommitUrl(release.sha)}`,
    ...(compare ? [`Mudanças desde a release anterior: ${compare}`] : []),
    "👉 Se foi a release, desfaça com um revert na main (docs/RELEASE.md, \"Desfazer uma release\"). "
      + "O veredito fica em Monitoramento › Desempenho.",
  ].join("\n");
}
