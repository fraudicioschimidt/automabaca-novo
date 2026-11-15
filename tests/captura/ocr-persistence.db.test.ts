import { beforeAll, beforeEach, afterEach, afterAll, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { registerCapturedBet } from "@/src/services/capture/register-captured-bet";
import { findBankrollByChannel } from "@/src/services/bankrolls/lookup";
import { extractionEvidence, extractionSourceFields, mapLlmBetToParsedList } from "@/src/services/capture/reading/extraction-mapping";
import { recordParseTelemetry } from "@/src/services/capture/parse-telemetry";
import { cachedLlmReading, saveLlmReading } from "@/src/infra/llm/reading-cache";
import { resetEnvCacheForTests } from "@/src/infra/env";
import type { LlmGenerateJsonParams } from "@/src/infra/llm/cascade";
vi.mock("@/src/services/ops/alerts", () => ({ sendOperationalAlert: vi.fn(), sendOperatorNotification: vi.fn() }));
let db: TestDb;
const now = new Date("2026-09-12T12:00:00Z");
const raw = { isBet: true, evento: "Alpha vs Beta", mercado: "Asian Handicap", selecao: "Alpha +1.0, +1.5", odds: 1.95, stake: .5,
  esporte: "Soccer", sportConfidence: 1, sportEvidenceText: "Futebol", liveScoreHome: 0, liveScoreAway: 0, liveScoreEvidence: "AO VIVO 0-0" };
const reader = { provider: "gemini" as const, model: "fixture-model", endpoint: "generate" as const, contractVersion: "bet-extraction-v2",
  contractHash: "contract", sourceHash: "source", responseHash: "response", receivedAt: now.toISOString() };
beforeAll(() => { db = createTestDb(); });
beforeEach(async () => { await db.reset(); });
afterEach(() => { vi.unstubAllEnvs(); resetEnvCacheForTests(); });
afterAll(async () => { await db.dispose(); });
it.each([["AO VIVO 0-0", 0], ["(0-0)", 0], [undefined, null]] as const)("grava leitor e linha dividida; live 0–0 exige evidência %s", async (liveScoreEvidence, expectedScore) => {
  await db.prisma.bankroll.create({ data: { nome: "OCR test", slug: "ocr-test", telegramChannelId: -10099n } });
  const bankroll = await findBankrollByChannel(-10099n);
  expect(bankroll).not.toBeNull();
  const source = { ...raw, liveScoreEvidence };
  const bet = mapLlmBetToParsedList(source, now)![0]!;
  bet.ocrEvidence = extractionEvidence(reader, extractionSourceFields(source), "complete", [bet]);
  const { result } = await registerCapturedBet({
    bankroll: bankroll!, bet: { ...bet, sportResolution: bet.sportResolution! }, client: db.prisma,
    origin: { source: "telegram-channel:-10099", sourceExternalId: "1", enteredAt: now, parser: "gemini-vision", actor: "telegram-channel:gemini-vision", caption: "0.5u" },
  });
  expect(result.created).toBe(true);
  const stored = await db.prisma.bet.findFirstOrThrow({ include: { captureEvidence: true } });
  expect(stored).toMatchObject({ selecao: "Alpha +1.25", liveScoreHome: expectedScore, liveScoreAway: expectedScore });
  expect(stored.captureEvidence?.parsedJson).toMatchObject({ ocrEvidence: { accuracy: "unreviewed", readers: [reader],
    sourceFields: { selecao: "Alpha +1.0, +1.5" }, registration: { selecao: "Alpha +1.25", liveScoreHome: expectedScore },
    transformations: expect.arrayContaining(["registration_selecao_normalization"]) } });
});
it("preserva a proveniência do rascunho no histórico, sem registrar uma aposta", async () => {
  const evidence = extractionEvidence(reader, extractionSourceFields({ ...raw, odds: null }), "draft")!;
  await recordParseTelemetry({ chatId: -10099n, messageId: 2 }, "unparseable", { via: "foto", missing: ["odds"], reason: "rascunho_sem_stake", ocrEvidence: evidence });
  const audit = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "telegram.parse" } });
  expect(audit.details).toMatchObject({ ocrEvidence: { state: "draft", readers: [reader], sourceFields: { odds: null } } });
  expect(await db.prisma.bet.count()).toBe(0);
});
it("reutiliza no PostgreSQL a leitura da revisão exata e registra somente cache hit", async () => {
  vi.stubEnv("LLM_OCR_CACHE", "1");
  vi.stubEnv("OBSERVABILITY_METRICS_IN_TEST", "true");
  resetEnvCacheForTests();
  const params: LlmGenerateJsonParams = { parts: [{ text: "private fixture" }], label: "channel-image", systemInstruction: "extract",
    responseSchema: {}, contractVersion: "v2", cacheContext: "revision1", contentState: () => "complete" };
  const route = { provider: "gemini", model: "fixture-model", endpoint: "generate" as const };
  await saveLlmReading(params, route, raw);
  expect((await cachedLlmReading(params, route))?.data).toEqual(raw);
  expect(await cachedLlmReading({ ...params, cacheContext: "revision2" }, route)).toBeNull();
  expect(await db.prisma.operationalMetric.count({ where: { name: "llm.attempt" } })).toBe(0);
  expect(await db.prisma.operationalMetric.count({ where: { name: "llm.cache" } })).toBe(1);
});
