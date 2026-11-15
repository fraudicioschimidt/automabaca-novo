import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { getOcrModelsReport } from "@/src/services/painel/ocr-models";
import { registerBet } from "@/src/services/bets/register";
import { applyBetEdit } from "@/src/services/bets/edit";
let db: TestDb;
beforeAll(() => { db = createTestDb(); });
beforeEach(async () => { await db.reset(); });
afterAll(async () => { await db.dispose(); });

it("separa quota, rejeição, custo desconhecido e janelas sem distorcer latência", async () => {
  const base = { kind: "provider", name: "llm.attempt", outcome: "error" };
  const labels = { provider: "gemini", model: "gemini-3.1-flash-lite", endpoint: "generate", modality: "image" };
  await db.prisma.operationalMetric.createMany({ data: [
    { ...base, outcome: "success", durationMs: 2000, statusCode: 200, labels: { ...labels, result: "accepted", extractionState: "complete", inputTokens: 4000, outputTokens: 300, paidEquivalentUsd: .00145 } },
    { ...base, durationMs: 4000, statusCode: 200, labels: { ...labels, result: "rejected", inputTokens: 4000, outputTokens: 300, paidEquivalentUsd: .00145 } },
    { ...base, durationMs: 10, statusCode: 429, labels: { ...labels, result: "rate_limit" } },
    { ...base, durationMs: 3000, statusCode: 200, occurredAt: new Date(Date.now() - 3 * 86400_000), labels: { ...labels, result: "accepted" } },
    { ...base, durationMs: 20, statusCode: 200, labels: { ...labels, modality: "text", result: "accepted" } },
  ] });
  const report = await getOcrModelsReport();
  expect(report.available).toBe(true);
  const row = report.periods[0]?.models.find((item) => item.model === labels.model);
  expect(row).toMatchObject({ attempts: 3, responses: 2, accepted: 1, complete: 1, rejected: 1, rateLimits: 1, averageMs: 3000, inputTokens: 8000, outputTokens: 600, pricedSamples: 2, usageSamples: 2 });
  expect(row?.p95Ms).toBeCloseTo(3900);
  expect(row?.paidEquivalentUsd).toBeCloseTo(.0029);
  expect(report.periods[1]?.models.find((item) => item.model === labels.model)).toMatchObject({ attempts: 4, responses: 3, pricedSamples: 2 });
  expect(report.periods[0]?.models.find((item) => item.model === "gemini-2.5-flash")).toMatchObject({ attempts: 0, paidEquivalentUsd: null, averageMs: null });
});

it("mostra o motivo da rejeição e mede o tempo só das leituras aptas", async () => {
  const base = { kind: "provider", name: "llm.attempt", outcome: "error", statusCode: 200 };
  const labels = { provider: "gemini", model: "gemini-3.1-flash-lite", endpoint: "generate", modality: "image" };
  await db.prisma.operationalMetric.createMany({ data: [
    { ...base, durationMs: 1000, outcome: "success", labels: { ...labels, result: "accepted", extractionState: "complete" } },
    { ...base, durationMs: 5000, labels: { ...labels, result: "rejected", extractionState: "draft" } },
    { ...base, durationMs: 7000, labels: { ...labels, result: "rejected", extractionState: "review" } },
  ] });
  const row = (await getOcrModelsReport()).periods[0]?.models.find((item) => item.model === labels.model);
  // O motivo do label é lido também para leituras rejeitadas, não só aceitas.
  expect(row).toMatchObject({ accepted: 1, rejected: 2, rejectedDraft: 1, rejectedReview: 1 });
  // O tempo médio soma a rejeição de 7s; o tempo útil olha só a leitura que serviu.
  expect(row?.usefulAverageMs).toBe(1000);
  expect(row?.usefulP95Ms).toBeCloseTo(1000);
  expect(row?.usefulSamples).toBe(1);
  expect(row?.averageMs).toBeCloseTo(13000 / 3);
  expect(row?.costPerAcceptedUsd).toBeNull();
});

it("compara por item usando a posição sorteada, não a tentativa", async () => {
  const base = { kind: "provider", name: "llm.attempt", outcome: "error", statusCode: 200, durationMs: 900 };
  const gemini = { provider: "gemini", model: "gemini-3.1-flash-lite", endpoint: "generate", modality: "image", task: "channel-image", llmEvaluationRandomized: true };
  const groq = { provider: "groq", model: "qwen/qwen3.8-27b", endpoint: "chat", modality: "image", task: "channel-image", llmEvaluationRandomized: true };
  const t = Date.now() - 3600_000;
  const at = (seconds: number) => new Date(t + seconds * 1000);
  await db.prisma.operationalMetric.createMany({ data: [
    // item 1: Gemini abre e aceita; Groq ainda tenta e rejeita.
    { ...base, outcome: "success", occurredAt: at(0), labels: { ...gemini, llmCallId: "item-1", result: "accepted" } },
    { ...base, occurredAt: at(1), labels: { ...groq, llmCallId: "item-1", result: "rejected" } },
    // item 2: Groq abre e falha; Gemini salva na segunda posição.
    { ...base, occurredAt: at(2), labels: { ...groq, llmCallId: "item-2", result: "rejected" } },
    { ...base, outcome: "success", occurredAt: at(3), labels: { ...gemini, llmCallId: "item-2", result: "accepted" } },
    // item 3: ninguém resolve.
    { ...base, occurredAt: at(4), labels: { ...gemini, llmCallId: "item-3", result: "rejected" } },
    { ...base, occurredAt: at(5), labels: { ...groq, llmCallId: "item-3", result: "rejected" } },
    // item 4: Gemini abre e falha; Groq resolve — falha exclusiva do Gemini.
    { ...base, occurredAt: at(6), labels: { ...gemini, llmCallId: "item-4", result: "rejected" } },
    { ...base, outcome: "success", occurredAt: at(7), labels: { ...groq, llmCallId: "item-4", result: "accepted" } },
  ] });
  const task = (await getOcrModelsReport()).comparisons.find((period) => period.days === 1)
    ?.tasks.find((item) => item.task === "channel-image");
  expect(task).toMatchObject({ items: 4, resolved: 3, withoutReading: 1, randomized: true });
  expect(task?.models.find((row) => row.model === gemini.model)).toMatchObject({
    assigned: 3, accepted: 1, produced: 3, rescueAttempts: 1, rescued: 1, uniqueFailures: 1,
  });
  expect(task?.models.find((row) => row.model === groq.model)).toMatchObject({
    assigned: 1, accepted: 0, produced: 1, rescueAttempts: 3, rescued: 1, uniqueFailures: 2,
  });
});

it("lista os itens que ninguém leu, com a tentativa mais antiga e a referência da mensagem", async () => {
  const base = { kind: "provider", name: "llm.attempt", outcome: "error", statusCode: 200, durationMs: 800 };
  const labels = { provider: "gemini", model: "gemini-3.1-flash-lite", endpoint: "generate", modality: "image", task: "channel-image", result: "rejected" };
  const at = new Date(Date.now() - 1800_000);
  await db.prisma.operationalMetric.createMany({ data: [
    { ...base, occurredAt: at, labels: { ...labels, llmCallId: "sem-leitura", chatIdHash: "abc123def4567890", messageId: 71 } },
    { ...base, occurredAt: new Date(at.getTime() + 1000), labels: { ...labels, llmCallId: "sem-leitura", model: "gemini-3.8-flash", chatIdHash: "abc123def4567890", messageId: 71 } },
  ] });
  const period = (await getOcrModelsReport()).comparisons.find((item) => item.days === 1);
  expect(period?.unresolved).toHaveLength(1);
  expect(period?.unresolved[0]).toMatchObject({ task: "channel-image", modelsTried: 2, chatIdHash: "abc123def4567890", messageId: 71 });
  expect(period?.unresolved[0]?.at).toBe(at.toISOString());
});

it("marca o modelo estacionado por indisponibilidade, e não o que só espera a cota do dia", async () => {
  const now = Date.now();
  await db.prisma.providerRequestGate.createMany({ data: [
    { provider: "llm:gemini:chave-a", route: "generate:gemini-3.1-flash-lite", nextAllowedAt: new Date(now + 7 * 86400_000) },
    { provider: "llm:gemini:chave-b", route: "generate:gemini-3.1-flash-lite", nextAllowedAt: new Date(now + 6 * 86400_000) },
    { provider: "llm:gemini:chave-a", route: "generate:gemini-2.5-flash", nextAllowedAt: new Date(now + 20 * 3600_000) },
  ] });
  const models = (await getOcrModelsReport()).periods[0]?.models ?? [];
  expect(models.find((item) => item.model === "gemini-3.1-flash-lite")).toMatchObject({
    parkedUntil: new Date(now + 7 * 86400_000).toISOString(), parkedCredentials: 2,
  });
  expect(models.find((item) => item.model === "gemini-2.5-flash")).toMatchObject({ parkedUntil: null, parkedCredentials: 0 });
});

it("resolver é ler a aposta completa: rascunho e consenso de não-aposta ficam sem leitura", async () => {
  const base = { kind: "provider", name: "llm.attempt", outcome: "success", statusCode: 200, durationMs: 900 };
  const labels = { provider: "gemini", model: "gemini-3.1-flash-lite", endpoint: "generate", modality: "image", task: "channel-image", result: "accepted" };
  await db.prisma.operationalMetric.createMany({ data: [
    { ...base, labels: { ...labels, llmCallId: "completa", extractionState: "complete" } },
    { ...base, labels: { ...labels, llmCallId: "rascunho", extractionState: "draft" } },
    { ...base, labels: { ...labels, llmCallId: "nao-aposta", extractionState: "not_bet" } },
  ] });
  const task = (await getOcrModelsReport()).comparisons.find((period) => period.days === 1)?.tasks.find((item) => item.task === "channel-image");
  expect(task).toMatchObject({ items: 3, resolved: 1, withoutReading: 2 });
  expect(task?.models[0]).toMatchObject({ assigned: 3, accepted: 1, produced: 3 });
});

it("a leitura de texto da captura entra na comparação por item, com a referência da mensagem", async () => {
  const base = { kind: "provider", name: "llm.attempt", outcome: "error", statusCode: 200, durationMs: 700 };
  const labels = { provider: "groq", model: "qwen/qwen3.8-27b", endpoint: "chat", modality: "text", result: "rejected", extractionState: "review" };
  await db.prisma.operationalMetric.createMany({ data: [
    { ...base, labels: { ...labels, task: "channel-text", llmCallId: "texto", chatIdHash: "abc123def4567890", messageId: 88 } },
    { ...base, labels: { ...labels, task: "ia-judge", llmCallId: "juiz" } },
  ] });
  const period = (await getOcrModelsReport()).comparisons.find((item) => item.days === 1);
  expect(period?.tasks.map((task) => task.task)).toEqual(["channel-text"]);
  expect(period?.unresolved[0]).toMatchObject({ task: "channel-text", messageId: 88 });
});

it("mede o acerto de cada leitor pela correção do dono, campo a campo", async () => {
  const bankroll = await db.prisma.bankroll.create({ data: { nome: "Canal", slug: "canal", valorUnidade: 100 } });
  const reading = { provider: "gemini", model: "gemini-3.1-flash-lite", endpoint: "generate", contractVersion: "bet-extraction-v2",
    contractHash: "h", sourceHash: "s", responseHash: "r", receivedAt: "2026-09-23T12:00:00.000Z" };
  const capture = async (id: string, parser: string, odds: number) => (await registerBet({
    bankrollId: bankroll.id, data: new Date(Date.now() + 86400_000), evento: `Time ${id} vs Rival ${id}`, esporte: "Soccer",
    mercado: "Total", selecao: "Over 2.5", odds, stake: 1, source: "telegram-channel:-100", sourceExternalId: id, actor: "telegram-channel",
    captureEvidence: { parser, caption: "tip", parsed: parser === "universal" ? {} : { ocrEvidence: {
      version: 1, state: "complete", accuracy: "unreviewed", readers: [reading], sourceFields: {}, transformations: [] } } },
  })).betId;
  const edit = async (betId: string, changes: Record<string, unknown>) => {
    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: betId } });
    await applyBetEdit({ betId, actor: "dono", financialAuthority: "operator", expectedVersion: bet.manualSettlementVersion, fields: {
      data: bet.data, evento: bet.evento, esporte: bet.esporte, competicao: bet.competicao, pais: bet.pais,
      mercado: bet.mercado, selecao: bet.selecao, odds: Number(bet.odds), stake: Number(bet.stake), ...changes } });
  };
  const ruleBets = [await capture("1", "universal", 1.9), await capture("2", "universal", 1.8), await capture("3", "universal", 1.7), await capture("4", "universal", 1.6)];
  const llmBet = await capture("5", "gemini-vision", 2.1);
  await edit(ruleBets[0]!, { selecao: "Over 3.5" });
  await edit(ruleBets[0]!, { odds: 1.95 });
  await edit(llmBet, { odds: 2.2, stake: 2 });

  const rows = (await getOcrModelsReport()).readers.find((period) => period.days === 7)?.rows ?? [];
  expect(rows).toEqual([
    { kind: "rule", provider: null, model: null, endpoint: null, contractVersion: null, registered: 4, corrected: 1,
      fields: { evento: 0, mercado: 0, selecao: 0, linha: 1, odds: 1, stake: 0 } },
    { kind: "llm", provider: "gemini", model: "gemini-3.1-flash-lite", endpoint: "generate", contractVersion: "bet-extraction-v2", registered: 1, corrected: 1,
      fields: { evento: 0, mercado: 0, selecao: 0, linha: 0, odds: 1, stake: 1 } },
  ]);
});


it("uma cascata que cruza a janela diária não promove o salvamento a primeira tentativa", async () => {
  const start = Date.now() - 86400_000 - 30_000;
  const base = { kind: "provider", name: "llm.attempt", outcome: "error", statusCode: 200 };
  const labels = { provider: "gemini", endpoint: "generate", modality: "image", task: "channel-image", llmCallId: "cross-window" };
  await db.prisma.operationalMetric.createMany({ data: [
    { ...base, occurredAt: new Date(start), labels: { ...labels, model: "first", result: "rejected" } },
    { ...base, outcome: "success", occurredAt: new Date(start + 60_000), labels: { ...labels, model: "rescue", result: "accepted" } },
  ] });
  const periods = (await getOcrModelsReport()).comparisons;
  expect(periods.find((p) => p.days === 1)?.tasks).toEqual([]);
  const task = periods.find((p) => p.days === 7)?.tasks[0];
  expect(task).toMatchObject({ items: 1, resolved: 1, randomized: false });
  expect(task?.models.find((m) => m.model === "first")).toMatchObject({ assigned: 1, accepted: 0 });
  expect(task?.models.find((m) => m.model === "rescue")).toMatchObject({ assigned: 0, rescued: 1 });
});

it("a origem gravada mantém fora dos 30 dias a cascata iniciada antes da janela", async () => {
  const start = Date.now() - 30 * 86400_000 - 60_000;
  await db.prisma.operationalMetric.create({ data: {
    kind: "provider", name: "llm.attempt", outcome: "success", statusCode: 200,
    occurredAt: new Date(start + 120_000), labels: {
      provider: "gemini", model: "last", endpoint: "generate", modality: "image", task: "channel-image",
      llmCallId: "old-origin", llmCallStartedAtMs: start, llmEvaluationRandomized: true, result: "accepted",
    },
  } });
  const periods = (await getOcrModelsReport()).comparisons;
  expect(periods.every((p) => p.tasks.length === 0)).toBe(true);
});

it("mudança de modelo em ordem fixa não prova avaliação aleatória", async () => {
  const labels = { provider: "gemini", endpoint: "generate", modality: "image", task: "channel-image", result: "accepted" };
  await db.prisma.operationalMetric.createMany({ data: ["a", "b"].map((model) => ({
    kind: "provider", name: "llm.attempt", outcome: "success", statusCode: 200,
    labels: { ...labels, model, llmCallId: `fixed-${model}`, llmEvaluationRandomized: false },
  })) });
  expect((await getOcrModelsReport()).comparisons[0]?.tasks[0]?.randomized).toBe(false);
});


it("labels de origem inválidos não derrubam o relatório nem comprovam sorteio", async () => {
  const start = Date.now() - 3600_000;
  const origins = ["inválido", null, -1, 1e100, Date.now() + 86400_000];
  await db.prisma.operationalMetric.createMany({ data: origins.map((origin, i) => ({
    kind: "provider", name: "llm.attempt", outcome: "success", statusCode: 200, occurredAt: new Date(start),
    labels: { provider: "gemini", model: "reader", endpoint: "generate", modality: "image", task: "channel-image",
      result: "accepted", llmCallId: `bad-origin-${i}`, llmCallStartedAtMs: origin, llmEvaluationRandomized: "true" },
  })) });
  const report = await getOcrModelsReport();
  expect(report.available).toBe(true);
  expect(report.comparisons[0]?.tasks[0]).toMatchObject({ items: 5, resolved: 5, randomized: false });
});
