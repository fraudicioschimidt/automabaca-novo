import { describe, expect, it } from "vitest";
import {
  countsAsReleaseError,
  isPublishedSha,
  judgeRelease,
  observationEndOf,
  releaseCompareUrl,
  releaseVerdictMessage,
  type ReleaseErrorOccurrence,
} from "@/src/domain/release-verdict";

const SHA = "6711865aa2b3c4d5e6f708192a3b4c5d6e7f8091";
const PREVIOUS_SHA = "5595c532bb2b3c4d5e6f708192a3b4c5d6e7f809";
const BOOT = new Date("2026-09-24T10:00:00Z");

function failure(fingerprint: string, minutes: number, extra: Partial<ReleaseErrorOccurrence> = {}): ReleaseErrorOccurrence {
  return {
    fingerprint,
    queue: fingerprint.split("|")[0] ?? "fila",
    text: `texto de ${fingerprint}`,
    releaseId: "auto-6711865",
    jobId: `job-${minutes}`,
    occurredAt: new Date(BOOT.getTime() + minutes * 60_000),
    ...extra,
  };
}

describe("erro que conta para o veredito da release", () => {
  it("conta erro de código e falha do banco", () => {
    expect(countsAsReleaseError({ name: "TypeError", message: "Cannot read properties of undefined (reading 'odds')" })).toBe(true);
    expect(countsAsReleaseError({ name: "ZodError", message: "Expected number, received string" })).toBe(true);
    // Consulta nova lenta demais é regressão possível, mesmo sendo retentada.
    expect(countsAsReleaseError({ name: "Error", message: "canceling statement due to statement timeout", code: "57014" })).toBe(true);
  });

  it("não conta o que vem de fora nem o próprio deploy", () => {
    expect(countsAsReleaseError({ name: "CircuitOpenError", message: "circuit breaker aberto para \"pinnacle17\"" })).toBe(false);
    expect(countsAsReleaseError({ name: "Error", message: "fetch failed" })).toBe(false);
    expect(countsAsReleaseError({ name: "ProviderRequestError", status: 404, message: "BridgeOdds respondeu 404" })).toBe(false);
    expect(countsAsReleaseError({ name: "PrePinnacleRetryError", message: "a Pinnacle ainda não lista o jogo" })).toBe(false);
    expect(countsAsReleaseError({ value: { message: "job shut down while active" } })).toBe(false);
    expect(countsAsReleaseError(null)).toBe(false);
  });
});

describe("julgamento da release", () => {
  it("aponta o erro que ela produziu e ninguém tinha visto, com tentativas, jobs e a primeira vez", () => {
    const judgement = judgeRelease({
      releaseId: "auto-6711865",
      occurrences: [
        failure("sharp.enrich|novo", 12, { jobId: "a" }),
        failure("sharp.enrich|novo", 5, { jobId: "a" }),
        failure("sharp.enrich|novo", 20, { jobId: "b" }),
        failure("closing.sync|velho", 7),
      ],
      known: new Set(["closing.sync|velho"]),
    });
    expect(judgement.verdict).toBe("erro_novo");
    expect(judgement.findings).toEqual([{
      fingerprint: "sharp.enrich|novo",
      queue: "sharp.enrich",
      text: "texto de sharp.enrich|novo",
      occurrences: 3,
      jobs: 2,
      firstAt: new Date("2026-09-24T10:05:00Z"),
    }]);
    // O que bateu o mínimo não aparece também como abaixo dele.
    expect(judgement.belowThreshold).toEqual([]);
    expect(judgement.knownErrors).toBe(1);
    expect(judgement.seen.sort()).toEqual(["closing.sync|velho", "sharp.enrich|novo"]);
  });

  it("erro já conhecido não aponta, por mais que se repita", () => {
    const judgement = judgeRelease({
      releaseId: "auto-6711865",
      occurrences: Array.from({ length: 40 }, (_, i) => failure("closing.sync|velho", i)),
      known: new Set(["closing.sync|velho"]),
    });
    expect(judgement).toMatchObject({ verdict: "sem_erro_novo", findings: [], knownErrors: 40 });
  });

  it("erro novo abaixo do mínimo não aponta, mas fica no veredito e passa a ser conhecido", () => {
    const judgement = judgeRelease({
      releaseId: "auto-6711865",
      occurrences: [
        failure("sharp.enrich|soluço", 3, { jobId: "a" }),
        failure("sharp.enrich|soluço", 9, { jobId: "b" }),
        failure("closing.sync|velho", 4),
      ],
      known: new Set(["closing.sync|velho"]),
    });
    expect(judgement).toMatchObject({ verdict: "sem_erro_novo", findings: [], knownErrors: 1 });
    expect(judgement.belowThreshold).toEqual([{
      fingerprint: "sharp.enrich|soluço",
      queue: "sharp.enrich",
      text: "texto de sharp.enrich|soluço",
      occurrences: 2,
      jobs: 2,
      firstAt: new Date("2026-09-24T10:03:00Z"),
    }]);
    expect(judgement.seen.sort()).toEqual(["closing.sync|velho", "sharp.enrich|soluço"]);
  });

  it("a release que durou pouco leva as tentativas da seguinte na observação dela", () => {
    const next = { releaseId: "auto-7e313fb" };
    const judgement = judgeRelease({
      releaseId: "auto-6711865",
      occurrences: [
        failure("sharp.enrich|novo", 2),
        failure("sharp.enrich|novo", 8, next),
        failure("sharp.enrich|novo", 15, next),
        // Só a seguinte produziu: é dela, não desta.
        failure("closing.sync|da-seguinte", 10, next),
        failure("closing.sync|da-seguinte", 11, next),
        failure("closing.sync|da-seguinte", 12, next),
      ],
      known: new Set(),
    });
    expect(judgement.findings.map((f) => [f.fingerprint, f.occurrences])).toEqual([["sharp.enrich|novo", 3]]);
    expect(judgement.seen).toEqual(["sharp.enrich|novo"]);
  });

  it("tentativa sem job conhecido conta como um job próprio", () => {
    const judgement = judgeRelease({
      releaseId: "auto-6711865",
      occurrences: [0, 1, 2].map((m) => failure("outbox.dispatch|novo", m, { jobId: null })),
      known: new Set(),
    });
    expect(judgement.findings[0]).toMatchObject({ occurrences: 3, jobs: 3 });
  });

  it("a observação acaba 45 min depois de a release ficar pronta", () => {
    expect(observationEndOf({ readyAt: new Date("2026-09-24T10:02:00Z") })).toEqual(new Date("2026-09-24T10:47:00Z"));
  });
});

describe("aviso da release com erro novo", () => {
  const release = { releaseId: "auto-6711865-20260924-6711865", sha: SHA, previousSha: PREVIOUS_SHA };
  const finding = { queue: "sharp.enrich", text: "TypeError: Cannot read properties of undefined", occurrences: 7, jobs: 2 };

  it("diz que apareceu junto, nunca que ela causou, e leva o commit e as mudanças", () => {
    const message = releaseVerdictMessage(release, [finding]);
    expect(message).toContain("Erro novo junto com a release auto-6711865-20260924-6711865");
    expect(message).toContain("• sharp.enrich — TypeError: Cannot read properties of undefined: 7× em 2 jobs");
    expect(message).toContain("não prova que ela é a causa");
    expect(message).not.toMatch(/causad[oa] por/i);
    expect(message).toContain(`/commit/${SHA}`);
    expect(message).toContain(`/compare/${PREVIOUS_SHA}...${SHA}`);
    expect(message).toContain("revert na main");
  });

  it("sem release anterior conhecida não inventa comparação, e resume a lista longa", () => {
    const message = releaseVerdictMessage({ ...release, previousSha: null },
      Array.from({ length: 7 }, (_, i) => ({ ...finding, queue: `fila.${i}`, jobs: 1 })));
    expect(message).not.toContain("/compare/");
    expect(message).toContain("• fila.4");
    expect(message).not.toContain("• fila.5");
    expect(message).toContain("… e mais 2.");
    expect(message).toContain("7× em 1 job\n");
  });

  it("só commit publicado é release, e comparar consigo mesmo não é comparação", () => {
    expect(isPublishedSha(SHA)).toBe(true);
    expect(isPublishedSha("development")).toBe(false);
    expect(isPublishedSha(SHA.slice(0, 7))).toBe(false);
    expect(releaseCompareUrl(SHA, SHA)).toBeNull();
    expect(releaseCompareUrl("development", SHA)).toBeNull();
  });
});
