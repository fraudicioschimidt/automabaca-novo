import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  cleanupOrphanedProviderBudgetReservations,
  consumeProviderBudgetReservation,
  reserveProviderBudget,
} from "@/src/providers/budget-reservations";
import { periodKeyFor } from "@/src/providers/budget-config";
import { pinnacle17ClosingReservedAttempt } from "@/src/providers/pinnacle17/sharp";

let db: TestDb;
const provider = "pinnacle17";
const purpose = "closing-fixture";

beforeAll(() => {
  db = createTestDb();
});

afterAll(async () => {
  await db.dispose();
});

beforeEach(async () => {
  await db.reset();
});

async function countProviderReservations(params: { provider: string; purpose: string; now?: Date }) {
  return db.prisma.providerBudgetReservation.count({
    where: {
      provider: params.provider,
      purpose: params.purpose,
      periodKey: periodKeyFor("day", params.now ?? new Date()),
    },
  });
}

async function budget(now = new Date()) {
  return db.prisma.providerBudget.findUnique({
    where: { provider_periodKey: { provider, periodKey: periodKeyFor("day", now) } },
  });
}

describe("reservas persistentes de quota Pinnacle17", () => {
  it("o retry de closing paga nova cota sem reutilizar a reserva", async () => {
    const resourceKey = "closing-retry-budget";
    await reserveProviderBudget({ provider, purpose: "closing", resourceKey });
    const attempt = pinnacle17ClosingReservedAttempt(resourceKey);
    await attempt();
    expect(await budget()).toMatchObject({ spent: 1, reserved: 0 });
    await attempt();
    expect(await budget()).toMatchObject({ spent: 2, reserved: 0 });
    await expect(attempt()).rejects.toThrow("esgotou as tentativas");
    expect(await budget()).toMatchObject({ spent: 2, reserved: 0 });
  });

  it("um retry não consome a última unidade reservada para outra aposta", async () => {
    const now = new Date();
    await db.prisma.providerBudget.create({ data: {
      provider, periodKey: periodKeyFor("day", now), spent: 9_498,
    } });
    await reserveProviderBudget({ provider, purpose: "closing", resourceKey: "closing-first" });
    await reserveProviderBudget({ provider, purpose: "closing", resourceKey: "closing-other" });
    const attempt = pinnacle17ClosingReservedAttempt("closing-first");
    await attempt();
    await expect(attempt()).rejects.toMatchObject({ name: "BudgetExhaustedError" });
    expect(await budget()).toMatchObject({ spent: 9_499, reserved: 1 });
  });

  it("deduplica atomicamente várias apostas da mesma fixture", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => reserveProviderBudget({
        provider,
        purpose,
        resourceKey: "id-same",
      })),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await countProviderReservations({ provider, purpose })).toBe(1);
    expect(await budget()).toMatchObject({ spent: 0, reserved: 1 });
  });

  it("inclui spent + reserved no teto diário de 9.500", async () => {
    const now = new Date("2026-08-10T12:00:00Z");
    await db.prisma.providerBudget.create({
      data: { provider, periodKey: periodKeyFor("day", now), spent: 9_499 },
    });
    await expect(reserveProviderBudget({
      provider,
      purpose,
      resourceKey: "id-last",
      now,
    })).resolves.toEqual({ ok: true, created: true });
    await expect(reserveProviderBudget({
      provider,
      purpose,
      resourceKey: "id-over",
      now,
    })).resolves.toEqual({ ok: false, created: false });
    expect(await budget(now)).toMatchObject({ spent: 9_499, reserved: 1 });
  });

  it("converte a reserva em consumo imediatamente antes da request", async () => {
    await reserveProviderBudget({ provider, purpose, resourceKey: "id-billed" });
    await expect(consumeProviderBudgetReservation({
      provider,
      purpose,
      resourceKey: "id-billed",
    })).resolves.toBe(true);
    expect(await budget()).toMatchObject({ spent: 1, reserved: 0 });
    expect(await countProviderReservations({ provider, purpose })).toBe(0);
  });

  it("falha sem resposta não reconstitui uma request física já iniciada", async () => {
    await reserveProviderBudget({ provider, purpose, resourceKey: "id-network" });
    await consumeProviderBudgetReservation({ provider, purpose, resourceKey: "id-network" });
    expect(await budget()).toMatchObject({ spent: 1, reserved: 0 });
    expect(await countProviderReservations({ provider, purpose })).toBe(0);
  });

  it("consome uma reserva no sucesso e não permite reutilizá-la", async () => {
    await reserveProviderBudget({ provider, purpose, resourceKey: "id-success" });
    await expect(consumeProviderBudgetReservation({
      provider,
      purpose,
      resourceKey: "id-success",
    })).resolves.toBe(true);
    await expect(consumeProviderBudgetReservation({
      provider,
      purpose,
      resourceKey: "id-success",
    })).resolves.toBe(false);
    expect(await budget()).toMatchObject({ spent: 1, reserved: 0 });
  });

  it("reconstitui a reserva em um novo periodKey diário", async () => {
    const august = new Date("2026-08-31T12:00:00Z");
    const september = new Date("2026-09-01T12:00:00Z");
    await reserveProviderBudget({ provider, purpose, resourceKey: "id-rollover", now: august });
    await reserveProviderBudget({ provider, purpose, resourceKey: "id-rollover", now: september });
    expect(await db.prisma.providerBudgetReservation.findMany({
      where: { provider, purpose, resourceKey: "id-rollover" },
      orderBy: { periodKey: "asc" },
      select: { periodKey: true },
    })).toEqual([{ periodKey: "2026-08-31" }, { periodKey: "2026-09-01" }]);
  });

  it("preserva 500 chamadas diárias da Pinnacle17 e deduplica o closing", async () => {
    const now = new Date("2026-08-24T12:00:00Z");
    const firstReference = "pinnacle17:v1:1634172613:0:moneyline:ml:home";
    await db.prisma.providerBudget.create({ data: {
      provider: "pinnacle17",
      periodKey: periodKeyFor("day", now),
      spent: 9_499,
    } });
    await expect(reserveProviderBudget({
      provider: "pinnacle17",
      purpose: "closing",
      resourceKey: firstReference,
      now,
    })).resolves.toEqual({ ok: true, created: true });
    await expect(reserveProviderBudget({
      provider: "pinnacle17",
      purpose: "closing",
      resourceKey: firstReference,
      now,
    })).resolves.toEqual({ ok: true, created: false });
    await expect(reserveProviderBudget({
      provider: "pinnacle17",
      purpose: "closing",
      resourceKey: "pinnacle17:v1:1634172614:0:moneyline:ml:away",
      now,
    })).resolves.toEqual({ ok: false, created: false });
  });

  it("limpa reservas órfãs com TTL > 72h liberando cotas presas", async () => {
    const past = new Date("2026-08-01T10:00:00Z");
    const now = new Date("2026-08-05T12:00:00Z"); // > 72h depois

    // Reserva antiga (> 72h) de evento encerrado/sem aposta pendente
    await reserveProviderBudget({
      provider,
      purpose,
      resourceKey: "fixture-orphan-1",
      now: past,
    });
    // Reserva recente (< 72h)
    await reserveProviderBudget({
      provider,
      purpose,
      resourceKey: "fixture-fresh-2",
      now: new Date("2026-08-05T10:00:00Z"),
    });

    expect(await budget(past)).toMatchObject({ reserved: 1 });
    expect(await budget(now)).toMatchObject({ reserved: 1 });

    const result = await cleanupOrphanedProviderBudgetReservations({ now });
    expect(result).toEqual({ cleaned: 1, releasedUnits: 1 });

    expect(await budget(past)).toMatchObject({ reserved: 0 });
    expect(await budget(now)).toMatchObject({ reserved: 1 });
    expect(await countProviderReservations({ provider, purpose, now })).toBe(1);
  });
});
