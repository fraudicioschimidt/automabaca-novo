import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { checkProviderBudgetAlerts } from "@/src/services/ops/budget-alerts";
import { chargeProviderRequest, consumeProviderBudget } from "@/src/providers/budget";
import { periodKeyFor, PROVIDER_CAPS } from "@/src/providers/budget-config";
import {
  BRIDGEODDS_CONTRACTED_REQUESTS_PER_HOUR,
  BRIDGEODDS_OPERATIONAL_REQUESTS_PER_HOUR,
} from "@/src/providers/bridgeodds/limits";
import { fetchJsonWithRetry } from "@/src/providers/core/http";

/**
 * Alertas de budget contra Postgres real: limiares 85%/100% com dedupe
 * DURÁVEL por (provider, período, nível) via AuditEvent.
 */

let db: TestDb;

// Um provider com cap finito e diário para o teste ser determinístico.
const CAP = PROVIDER_CAPS.find((c) => Number.isFinite(c.cap) && c.period === "day")!;

beforeAll(() => {
  db = createTestDb();
});

afterAll(async () => {
  await db.dispose();
});

beforeEach(async () => {
  await db.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function gastar(spent: number, now: Date) {
  await db.prisma.providerBudget.create({
    data: { provider: CAP.provider, periodKey: periodKeyFor(CAP.period, now), spent },
  });
}

describe("checkProviderBudgetAlerts (Postgres real)", () => {
  const now = new Date("2026-08-01T12:00:00Z");

  it("abaixo de 85% não emite nada", async () => {
    await gastar(Math.floor(CAP.cap * 0.5), now);
    await checkProviderBudgetAlerts(now);
    expect(await db.prisma.auditEvent.count({ where: { action: "budget_alert" } })).toBe(0);
  });

  it("≥85% emite warn UMA vez por período e mantém a ação aberta", async () => {
    await gastar(Math.ceil(CAP.cap * 0.9), now);
    await checkProviderBudgetAlerts(now);
    const acao = await db.prisma.operationalAction.findFirstOrThrow({
      where: { fingerprint: { startsWith: "budget:" } },
    });
    await db.prisma.operationalAction.update({
      where: { id: acao.id },
      data: { status: "RESOLVED", resolvedAt: now },
    });
    await checkProviderBudgetAlerts(now); // segunda rodada não duplica
    const eventos = await db.prisma.auditEvent.findMany({ where: { action: "budget_alert" } });
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.resourceId).toContain(":warn");
    await expect(db.prisma.operationalAction.findUniqueOrThrow({ where: { id: acao.id } }))
      .resolves.toMatchObject({ status: "OPEN", occurrenceCount: 1 });
  });

  it("estourar 100% emite o nível critical além do warn anterior", async () => {
    await gastar(Math.ceil(CAP.cap * 0.9), now);
    await checkProviderBudgetAlerts(now);
    await db.prisma.providerBudget.updateMany({
      where: { provider: CAP.provider },
      data: { spent: CAP.cap },
    });
    await checkProviderBudgetAlerts(now);
    const niveis = (
      await db.prisma.auditEvent.findMany({ where: { action: "budget_alert" } })
    ).map((e) => e.resourceId?.split(":")[1]);
    expect(niveis.sort()).toEqual(["critical", "warn"]);
  });
});

describe("consumeProviderBudget (Postgres real)", () => {
  const now = new Date("2026-08-01T12:00:00Z");

  it("custo único acima do teto é recusado e NÃO insere linha", async () => {
    expect(await consumeProviderBudget(CAP.provider, CAP.cap + 1, now)).toBe(false);
    expect(await db.prisma.providerBudget.count()).toBe(0);
  });

  it("custo dentro do teto reserva e acumula atomicamente", async () => {
    expect(await consumeProviderBudget(CAP.provider, 1, now)).toBe(true);
    expect(await consumeProviderBudget(CAP.provider, 1, now)).toBe(true);
    const row = await db.prisma.providerBudget.findFirstOrThrow({ where: { provider: CAP.provider } });
    expect(row.spent).toBe(2);
  });

  it("recusa quando spent + cost ultrapassaria o teto, sem mexer no spent", async () => {
    await consumeProviderBudget(CAP.provider, CAP.cap, now); // enche até o teto
    expect(await consumeProviderBudget(CAP.provider, 1, now)).toBe(false); // +1 estouraria
    const row = await db.prisma.providerBudget.findFirstOrThrow({ where: { provider: CAP.provider } });
    expect(row.spent).toBe(CAP.cap); // intacto
  });

  it("bridgeodds tem guarda-corpo horário que rastreia e recusa acima do teto", async () => {
    const bridge = PROVIDER_CAPS.find((c) => c.provider === "bridgeodds")!;
    // Enquanto o fornecedor não esclarece a divergência com os 1.000/h
    // informados verbalmente, o guarda-corpo segue o teto repetido em produção.
    expect(BRIDGEODDS_OPERATIONAL_REQUESTS_PER_HOUR).toBe(90);
    expect(BRIDGEODDS_CONTRACTED_REQUESTS_PER_HOUR).toBe(100);
    expect(bridge).toMatchObject({
      period: "hour",
      cap: BRIDGEODDS_OPERATIONAL_REQUESTS_PER_HOUR,
      contracted: BRIDGEODDS_CONTRACTED_REQUESTS_PER_HOUR,
    });
    expect(await consumeProviderBudget("bridgeodds", bridge.cap, now)).toBe(true);
    expect(await consumeProviderBudget("bridgeodds", 1, now)).toBe(false);
    const row = await db.prisma.providerBudget.findFirstOrThrow({
      where: { provider: "bridgeodds" },
    });
    expect(row.spent).toBe(bridge.cap);
    expect(row.periodKey).toBe(periodKeyFor("hour", now));
  });
});

describe("budget por request física", () => {
  const spentOf = async (provider: string): Promise<number> => {
    const row = await db.prisma.providerBudget.findFirst({ where: { provider } });
    return row?.spent ?? 0;
  };

  async function budgetedFetch() {
    return fetchJsonWithRetry({
      url: "https://provider.invalid/physical-budget",
      label: "physical-budget",
      maxRetries: 2,
      baseBackoffMs: 0,
      beforeAttempt: () => chargeProviderRequest("pinnacle17", "test"),
    });
  }

  it("sucesso: uma request física incrementa spent em uma unidade", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await budgetedFetch();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await spentOf("pinnacle17")).toBe(1);
  });

  it("5xx seguido de sucesso: cada tentativa incrementa spent", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(Response.json({ error: "down" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await budgetedFetch();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await spentOf("pinnacle17")).toBe(2);
  });

  it("falha sem resposta: cada tentativa física incrementa spent", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    await budgetedFetch();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await spentOf("pinnacle17")).toBe(3);
  });

  it("teto esgotado barra a tentativa antes do fetch", async () => {
    const cap = PROVIDER_CAPS.find((item) => item.provider === "pinnacle17");
    if (!cap) throw new Error("Pinnacle17 sem limite configurado");
    await consumeProviderBudget("pinnacle17", cap.cap);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(budgetedFetch()).rejects.toMatchObject({
      name: "BudgetExhaustedError",
      requestLabel: "test",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
