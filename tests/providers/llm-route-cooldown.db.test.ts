import { afterAll, expect, it, vi } from "vitest";
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("@/src/infra/logger", () => ({ createLogger: () => log }));
import { prisma, disconnectPrisma } from "@/src/infra/prisma";
import { deferLlmRoute, llmRouteAvailable, reportUnavailableRoute } from "@/src/infra/llm/route-cooldown";
const provider = "test-llm-cooldown";
const route = { provider, key: "synthetic-key", model: "model-a", endpoint: "chat" };
afterAll(async () => {
  await prisma.providerRequestGate.deleteMany({ where: { provider: { startsWith: `llm:${provider}:` } } });
  await disconnectPrisma();
});
it("compartilha cooldown persistente sem bloquear outro modelo ou outra chave", async () => {
  await deferLlmRoute(route, 429, "", "120");
  await deferLlmRoute(route, 429, "", "1");
  expect(await llmRouteAvailable(route)).toBe(false);
  expect(await llmRouteAvailable({ ...route, model: "model-b" })).toBe(true);
  expect(await llmRouteAvailable({ ...route, key: "another-synthetic-key" })).toBe(true);
  const row = await prisma.providerRequestGate.findFirstOrThrow({ where: { provider: { startsWith: `llm:${provider}:` } } });
  expect(row.nextAllowedAt.getTime()).toBeGreaterThan(Date.now() + 100_000);
  expect(JSON.stringify(row)).not.toContain("synthetic-key");
});
it("autenticação negada bloqueia a credencial em todos seus modelos", async () => {
  await deferLlmRoute(route, 401);
  expect(await llmRouteAvailable({ ...route, model: "model-b" })).toBe(false);
  expect(await llmRouteAvailable({ ...route, key: "new-synthetic-key" })).toBe(true);
});
it("modelo estacionado sai em warn com modelo e motivo, e o cooldown curto continua em info", async () => {
  log.warn.mockClear(); log.info.mockClear();
  await deferLlmRoute({ ...route, model: "labs-model" }, 403, "Model labs-model is a Labs model. To use Labs models, an admin must enable them");
  expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({
    eventCode: "LLM_MODEL_PARKED", model: "labs-model", reason: "model_permanently_unavailable", status: 403,
  }), expect.any(String));
  await deferLlmRoute({ ...route, model: "busy-model" }, 503, "overloaded");
  expect(log.warn).toHaveBeenCalledTimes(1);
  expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ model: "busy-model", reason: "transient" }), expect.any(String));
});
it("bloqueio além de 1 h é fora da rotação para a cascata; cooldown curto é queda", async () => {
  const outcomes: string[] = [];
  const report = (outcome: string, model: string) => { outcomes.push(`${model}:${outcome}`); };
  // Chave própria: a credencial de `route` foi bloqueada (401) no teste acima.
  const key = { ...route, key: "cutoff-synthetic-key" };
  const parked = { ...key, model: "missing-model" }, daily = { ...key, model: "daily-quota-model" };
  const shortWait = { ...key, model: "short-wait-model" }, busy = { ...key, model: "slow-model" };
  await deferLlmRoute(parked, 404, "model not found");
  await deferLlmRoute(daily, 429, "Quota exceeded: requests per day", "10800");
  await deferLlmRoute(shortWait, 429, "Rate limit reached", "1800");
  await deferLlmRoute(busy, 503, "overloaded");
  for (const blocked of [parked, daily, shortWait, busy]) await reportUnavailableRoute(blocked, report, blocked.model);
  expect(outcomes).toEqual(["short-wait-model:unavailable", "slow-model:unavailable"]);
});
it("credencial bloqueada (401, 402, chave recusada, crédito esgotado) é fora da rotação desde o primeiro minuto", async () => {
  const outcomes: string[] = [];
  const report = (outcome: string, model: string) => { outcomes.push(`${model}:${outcome}`); };
  const revoked = { ...route, key: "revoked-synthetic-key", model: "any-model" };
  const invalid = { ...route, key: "invalid-synthetic-key", model: "any-model" };
  const billing = { ...route, key: "billing-synthetic-key", model: "any-model" };
  await deferLlmRoute(revoked, 401, "invalid api key");
  await deferLlmRoute({ ...invalid, model: "other-model" }, 400, '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}');
  await deferLlmRoute(billing, 429, "Your credit balance is exhausted");
  for (const blocked of [revoked, invalid, billing]) await reportUnavailableRoute(blocked, report, blocked.model);
  expect(outcomes).toEqual([]);
});
it("credencial recusada sai em warn com a dica de trocar a chave", async () => {
  log.warn.mockClear();
  await deferLlmRoute({ ...route, key: "expired-synthetic-key" }, 400, "API key expired. Please renew the API key.");
  expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({
    eventCode: "LLM_CREDENTIAL_BLOCKED", reason: "authentication", status: 400, actionableHint: expect.any(String),
  }), expect.any(String));
});
