import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { withSampleCorrelationIds } from "@/src/services/ops/slo/slo-log";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb;
beforeAll(() => { db = createTestDb(); });
beforeEach(async () => { await db.reset(); });
afterAll(async () => { await db.dispose(); });

const minutosAtras = (minutos: number) => new Date(Date.now() - minutos * 60_000);

async function metrica(name: string, correlationId: string | null, minutos: number) {
  await db.prisma.operationalMetric.create({
    data: {
      kind: "queue", name, outcome: "failure", occurredAt: minutosAtras(minutos),
      labels: correlationId === null ? {} : { correlationId },
    },
  });
}

it("anexa à série violada até 5 correlationIds distintos, do mais recente, só da última hora", async () => {
  for (let i = 0; i < 7; i += 1) await metrica("sharp.enrich", `job_${i}`, i + 1);
  await metrica("sharp.enrich", "job_0", 30);        // repetido: conta uma vez
  await metrica("sharp.enrich", null, 2);            // sem correlação: ignorado
  await metrica("sharp.enrich", "job_antigo", 90);   // fora da janela de 1h
  await metrica("outra.fila", "job_de_outra", 1);    // outra série

  const [violada, saudavel] = await withSampleCorrelationIds([
    { kind: "queue", name: "sharp.enrich", status: "breach" as const },
    { kind: "queue", name: "outra.fila", status: "healthy" as const },
  ]);

  expect(violada?.sampleCorrelationIds).toEqual(["job_0", "job_1", "job_2", "job_3", "job_4"]);
  expect(saudavel).not.toHaveProperty("sampleCorrelationIds");
});

it("sem violação não consulta nada e devolve as linhas como vieram", async () => {
  const linhas = [{ kind: "queue", name: "x", status: "warning" as const }];
  expect(await withSampleCorrelationIds(linhas)).toBe(linhas);
});

it("violação sem nenhuma correlação na janela não ganha o campo", async () => {
  await metrica("sem.correlacao", null, 5);
  const [linha] = await withSampleCorrelationIds([{ kind: "queue", name: "sem.correlacao", status: "breach" as const }]);
  expect(linha).not.toHaveProperty("sampleCorrelationIds");
});
