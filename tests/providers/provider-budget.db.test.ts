import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  chargeClosingSeriesBudget,
  consumeProviderBudget,
  reconcileProviderBudgetFromProvider,
} from "@/src/providers/budget";
import { spDayKey } from "@/src/domain/dates";
import { periodKeyFor } from "@/src/providers/budget-config";
import {
  FLASHSCORE_DAILY_CONTRACTED_REQUESTS,
  FLASHSCORE_DAILY_OPERATIONAL_CAP,
} from "@/src/providers/flashscore/limits";

/**
 * O contador de cota é do FORNECEDOR, não nosso: a nossa janela vira à
 * meia-noite de São Paulo e a dele em outro horário, então o nosso contador
 * pode estar folgado enquanto a API já responde 429 com `remaining: 0`.
 * Alinhar relógios seria adivinhação; o header é medição. A verdade é dele, o
 * nosso `spent` é o espelho, e dentro da mesma janela o espelho só sobe.
 */

let db: TestDb;
const AGORA = new Date("2026-08-05T12:00:00Z");
const CHAVE = periodKeyFor("day", AGORA);

async function spent(): Promise<number | null> {
  const row = await db.prisma.providerBudget.findUnique({
    where: { provider_periodKey: { provider: "flashscore", periodKey: CHAVE } },
    select: { spent: true },
  });
  return row?.spent ?? null;
}

async function janela(): Promise<Date | null> {
  const row = await db.prisma.providerBudget.findUnique({
    where: { provider_periodKey: { provider: "flashscore", periodKey: CHAVE } },
    select: { windowResetAt: true },
  });
  return row?.windowResetAt ?? null;
}

/** Segundos até a virada, como o RapidAPI publica em `x-ratelimit-requests-reset`. */
const UMA_HORA = 3_600;

beforeEach(async () => {
  db = db ?? createTestDb();
  await db.reset();
});

afterAll(async () => {
  await db.dispose();
});

describe("reconciliação do budget com o contador do provider", () => {
  it("sobe o gasto para o que o fornecedor diz, mesmo sem linha nenhuma", async () => {
    // Contratado 10.000, sobraram 200 → cobrou 9.800 nesta janela
    // dele, ainda que a nossa tenha acabado de virar.
    await reconcileProviderBudgetFromProvider("flashscore", 200, null, AGORA);
    expect(await spent()).toBe(FLASHSCORE_DAILY_CONTRACTED_REQUESTS - 200);
  });

  it("é o que faz o teto valer: depois de reconciliar, a reserva é recusada", async () => {
    // 375 gastas na nossa conta com a cota real esgotada: sem reconciliar,
    // `consumeProviderBudget` liberaria chamadas para uma API que só devolve 429.
    for (let i = 0; i < 375; i += 1) {
      expect(await consumeProviderBudget("flashscore", 1, AGORA)).toBe(true);
    }
    expect(await spent()).toBe(375);

    await reconcileProviderBudgetFromProvider("flashscore", 0, null, AGORA);

    expect(await spent()).toBe(FLASHSCORE_DAILY_CONTRACTED_REQUESTS);
    expect(await consumeProviderBudget("flashscore", 1, AGORA)).toBe(false);
  });

  it("NUNCA devolve cota: header otimista não pode desfazer gasto já contado", async () => {
    for (let i = 0; i < 500; i += 1) {
      expect(await consumeProviderBudget("flashscore", 1, AGORA)).toBe(true);
    }
    // Resposta de cache, corrida entre duas chamadas ou header defasado: seja
    // qual for o motivo, abaixar o contador reabriria o teto que a realidade já
    // fechou. O erro fica sempre para o lado seguro.
    await reconcileProviderBudgetFromProvider(
      "flashscore",
      FLASHSCORE_DAILY_CONTRACTED_REQUESTS - 100,
      null,
      AGORA,
    );
    expect(await spent()).toBe(500);
  });

  it("ignora valor que não é contagem plausível", async () => {
    await consumeProviderBudget("flashscore", 10, AGORA);
    await reconcileProviderBudgetFromProvider("flashscore", Number.NaN, null, AGORA);
    await reconcileProviderBudgetFromProvider("flashscore", -1, null, AGORA);
    expect(await spent()).toBe(10);
  });

  it("provider sem cap configurado é no-op, não erro", async () => {
    await expect(
      reconcileProviderBudgetFromProvider("provider-que-nao-existe", 5, null, AGORA),
    ).resolves.toBeUndefined();
  });
});

/**
 * A janela do fornecedor, que é de quem a cota realmente é. O monotônico acima
 * vale DENTRO de uma janela; ATRAVÉS dela, o contador cravado acima do teto
 * recusaria todo ciclo até a nossa `periodKey` virar, e o header que provaria a
 * liberação só viria numa chamada que nós mesmos recusamos.
 */
describe("janela de cota do fornecedor", () => {
  it("gasto de janela NOVA recomeça em vez de somar", async () => {
    await reconcileProviderBudgetFromProvider("flashscore", 0, UMA_HORA, AGORA);
    expect(await spent()).toBe(FLASHSCORE_DAILY_CONTRACTED_REQUESTS);

    // Uma hora e um minuto depois o fornecedor recomeçou a contar: 24h até a
    // próxima virada e nada gasto. Nossa conta acompanha, não acumula.
    const depois = new Date(AGORA.getTime() + (UMA_HORA + 60) * 1_000);
    await reconcileProviderBudgetFromProvider(
      "flashscore",
      FLASHSCORE_DAILY_CONTRACTED_REQUESTS,
      24 * UMA_HORA,
      depois,
    );
    expect(await spent()).toBe(0);
  });

  it("dentro da MESMA janela continua monotônico", async () => {
    await reconcileProviderBudgetFromProvider("flashscore", 100, UMA_HORA, AGORA);
    expect(await spent()).toBe(FLASHSCORE_DAILY_CONTRACTED_REQUESTS - 100);

    // Cinco minutos depois: `reset` caiu junto com o relógio, então o instante
    // derivado é o mesmo — é a mesma janela, e header otimista não devolve cota.
    const cincoMin = new Date(AGORA.getTime() + 300_000);
    await reconcileProviderBudgetFromProvider(
      "flashscore",
      FLASHSCORE_DAILY_CONTRACTED_REQUESTS - 200,
      UMA_HORA - 300,
      cincoMin,
    );
    expect(await spent()).toBe(FLASHSCORE_DAILY_CONTRACTED_REQUESTS - 100);
  });

  it("a reserva volta a passar assim que a janela do fornecedor vira", async () => {
    await reconcileProviderBudgetFromProvider("flashscore", 0, UMA_HORA, AGORA);
    expect(await consumeProviderBudget("flashscore", 1, AGORA)).toBe(false);

    // Este é o caso que custou 11h30. Sem a janela gravada, a resposta aqui
    // seria `false` até a virada da NOSSA chave, às 03:00 UTC.
    const passouAJanela = new Date(AGORA.getTime() + (UMA_HORA + 1) * 1_000);
    expect(await consumeProviderBudget("flashscore", 1, passouAJanela)).toBe(true);
    expect(await spent()).toBe(1);
    // E a janela vencida é esquecida junto: quem manda de novo é o teto.
    expect(await janela()).toBeNull();
  });

  it("linha acima do teto sem janela conhecida libera UMA sonda, depois do cooldown", async () => {
    // Linha escrita por uma reconciliação antiga, que não sabia expirar.
    // `consumeProviderBudget` nunca produz `spent > cap`,
    // então essa forma identifica sozinha o dado do modelo velho — e é o que faz
    // o deploy destravar sem ninguém mexer no banco.
    await db.prisma.providerBudget.create({
      data: {
        provider: "flashscore",
        periodKey: CHAVE,
        spent: FLASHSCORE_DAILY_CONTRACTED_REQUESTS,
        updatedAt: new Date(AGORA.getTime() - 2 * UMA_HORA * 1_000),
      },
    });

    expect(await consumeProviderBudget("flashscore", 1, AGORA)).toBe(true);
    expect(await spent()).toBe(FLASHSCORE_DAILY_CONTRACTED_REQUESTS + 1);
    expect(await consumeProviderBudget("flashscore", 1, AGORA)).toBe(false);

    // A sonda ensina a janela; daí em diante vale o teto normal.
    await reconcileProviderBudgetFromProvider(
      "flashscore",
      FLASHSCORE_DAILY_CONTRACTED_REQUESTS - 1,
      24 * UMA_HORA,
      AGORA,
    );
    expect(await spent()).toBe(1);
    expect(await janela()).not.toBeNull();
  });

  it("não sonda logo após o fornecedor dizer que não tem cota", async () => {
    // Sem reset no header, `spent` acima do teto é a mesma forma da linha presa
    // — mas aqui ela ACABOU de ser escrita por um `remaining: 0`. Perguntar de
    // novo agora é gastar chamada numa API que já respondeu que não tem.
    await reconcileProviderBudgetFromProvider("flashscore", 0, null, AGORA);
    expect(await spent()).toBe(FLASHSCORE_DAILY_CONTRACTED_REQUESTS);
    expect(await consumeProviderBudget("flashscore", 1, AGORA)).toBe(false);

    // Uma hora depois, sim: é o teto do blackout auto-infligido.
    const depois = new Date(AGORA.getTime() + UMA_HORA * 1_000 + 1_000);
    expect(await consumeProviderBudget("flashscore", 1, depois)).toBe(true);
    expect(await spent()).toBe(FLASHSCORE_DAILY_CONTRACTED_REQUESTS + 1);
    expect(await consumeProviderBudget("flashscore", 1, depois)).toBe(false);

    // Sem header de reset, uma nova sonda só pode passar após outro cooldown;
    // o primeiro probe jamais reabre as 900 unidades do teto local.
    const outroCooldown = new Date(depois.getTime() + UMA_HORA * 1_000 + 1_000);
    expect(await consumeProviderBudget("flashscore", 1, outroCooldown)).toBe(true);
    expect(await spent()).toBe(FLASHSCORE_DAILY_CONTRACTED_REQUESTS + 2);
  });

  it("sem header de reset o comportamento seguro fica de pé", async () => {
    await reconcileProviderBudgetFromProvider("flashscore", 100, UMA_HORA, AGORA);
    expect(await spent()).toBe(FLASHSCORE_DAILY_CONTRACTED_REQUESTS - 100);

    // Resposta sem `reset`: não sabemos de que janela é este saldo, então só
    // sobe. Devolver cota por causa de um header incompleto é o erro caro.
    await reconcileProviderBudgetFromProvider(
      "flashscore",
      FLASHSCORE_DAILY_CONTRACTED_REQUESTS,
      null,
      AGORA,
    );
    expect(await spent()).toBe(FLASHSCORE_DAILY_CONTRACTED_REQUESTS - 100);
    expect(await janela()).not.toBeNull();
  });

  it("mantém o teto operacional abaixo do hard limit contratado", () => {
    expect(FLASHSCORE_DAILY_OPERATIONAL_CAP)
      .toBeLessThan(FLASHSCORE_DAILY_CONTRACTED_REQUESTS);
  });
});

describe("teto diário das consultas extras do fechamento da Pinnacle17", () => {
  it("gastos concorrentes respeitam o último slot do dia", async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
      db.prisma.$transaction((tx) => chargeClosingSeriesBudget(tx, new Date(), 1))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await db.prisma.closingPriceBudget.findFirstOrThrow()).spent).toBe(1);
    expect((await db.prisma.providerBudget.findFirstOrThrow()).spent).toBe(1);
  });

  it("o teto diário próprio recusa com o rótulo da série e desfaz a cobrança", async () => {
    const now = new Date();
    await db.prisma.$transaction((tx) => chargeClosingSeriesBudget(tx, now, 1));
    await expect(db.prisma.$transaction((tx) => chargeClosingSeriesBudget(tx, now, 1)))
      .rejects.toMatchObject({ name: "BudgetExhaustedError", requestLabel: "closing-series-daily-cap" });
    expect((await db.prisma.closingPriceBudget.findFirstOrThrow()).spent).toBe(1);
    expect((await db.prisma.providerBudget.findFirstOrThrow()).spent).toBe(1);
  });

  it("reset conhecido preserva reservas e reinicia somente o gasto normal", async () => {
    const now = new Date();
    await db.prisma.providerBudget.create({ data: { provider: "pinnacle17", periodKey: spDayKey(now),
      spent: 9500, reserved: 4, windowResetAt: new Date(now.getTime() - 1_000) } });
    await db.prisma.$transaction((tx) => chargeClosingSeriesBudget(tx, now, 500));
    const budget = await db.prisma.providerBudget.findFirstOrThrow();
    expect([budget.spent, budget.reserved, budget.windowResetAt]).toEqual([1, 4, null]);
  });

  it("rejeição por quota normal (80% do teto) desfaz também o gasto da série", async () => {
    const now = new Date();
    await db.prisma.providerBudget.create({ data: { provider: "pinnacle17", periodKey: spDayKey(now), spent: 7599, reserved: 1 } });
    await expect(db.prisma.$transaction((tx) => chargeClosingSeriesBudget(tx, now, 500)))
      .rejects.toMatchObject({ requestLabel: "closing-series-normal-headroom" });
    expect(await db.prisma.closingPriceBudget.count()).toBe(0);
    expect((await db.prisma.providerBudget.findFirstOrThrow()).spent).toBe(7599);
  });
});
