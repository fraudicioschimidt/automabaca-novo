import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  CircuitOpenError,
  closeExpiredBreaker,
  isBreakerOpen,
  resetBreakerForTests,
  tripBreaker,
  withBreaker,
} from "@/src/infra/circuit-breaker";
import { BudgetExhaustedError, ProviderRequestError } from "@/src/domain/provider-error";

/**
 * Breaker com estado no Postgres (web e worker veem o mesmo), testado contra
 * banco real: é a atomicidade do claim/contagem que importa, mock não pega.
 */

let db: TestDb;
const NAME = "provider-teste";

beforeAll(() => {
  db = createTestDb();
});

afterAll(async () => {
  await db.dispose();
});

beforeEach(async () => {
  await resetBreakerForTests(NAME);
});

const boom = async (): Promise<never> => {
  throw new Error("provider fora do ar");
};

async function failNTimes(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await expect(withBreaker(NAME, boom)).rejects.toThrow("provider fora do ar");
  }
}

async function forceCooldownExpired(): Promise<void> {
  // RESET_TIMEOUT_MS = 15 min — openedAt precisa ser mais antigo que isso.
  await db.prisma.providerCircuit.update({
    where: { provider: NAME },
    data: { openedAt: new Date(Date.now() - 16 * 60_000) },
  });
}

describe("circuit breaker no Postgres", () => {
  it("abre após 5 falhas seguidas e rejeita sem chamar o provider", async () => {
    await failNTimes(5);
    const row = await db.prisma.providerCircuit.findUnique({ where: { provider: NAME } });
    expect(row?.state).toBe("OPEN");

    let chamado = false;
    await expect(
      withBreaker(NAME, async () => {
        chamado = true;
      }),
    ).rejects.toThrow(CircuitOpenError);
    expect(chamado).toBe(false);
  });

  it("sucesso zera a contagem de falhas (falhas intercaladas nunca abrem)", async () => {
    await failNTimes(4);
    await withBreaker(NAME, async () => "ok");
    await failNTimes(4);
    const row = await db.prisma.providerCircuit.findUnique({ where: { provider: NAME } });
    expect(row?.state).not.toBe("OPEN");
  });

  it("budget esgotado antes do fetch não conta falha estrutural do provider", async () => {
    await expect(withBreaker(NAME, async () => {
      throw new BudgetExhaustedError(NAME, "fixtures");
    })).rejects.toMatchObject({ name: "BudgetExhaustedError" });

    expect(await db.prisma.providerCircuit.findUnique({ where: { provider: NAME } }))
      .toBeNull();
  });

  it("sucesso antigo não fecha breaker aberto enquanto a request estava em voo", async () => {
    let liberar!: () => void;
    const lenta = withBreaker(NAME, () => new Promise<string>((resolve) => {
      liberar = () => resolve("antiga");
    }));
    await failNTimes(5);
    liberar();
    await expect(lenta).resolves.toBe("antiga");
    const row = await db.prisma.providerCircuit.findUniqueOrThrow({ where: { provider: NAME } });
    expect(row.state).toBe("OPEN");
  });

  it("após o cooldown, sonda com sucesso fecha o breaker", async () => {
    await failNTimes(5);
    await forceCooldownExpired();
    await expect(withBreaker(NAME, async () => "vivo")).resolves.toBe("vivo");
    const row = await db.prisma.providerCircuit.findUnique({ where: { provider: NAME } });
    expect(row?.state).toBe("CLOSED");
    expect(row?.failures).toBe(0);
  });

  it("OPEN legado sem openedAt entra em half-open em vez de ficar preso", async () => {
    await db.prisma.providerCircuit.create({
      data: { provider: NAME, state: "OPEN", failures: 5, openedAt: null },
    });
    await expect(withBreaker(NAME, async () => "recuperou")).resolves.toBe("recuperou");
    const row = await db.prisma.providerCircuit.findUniqueOrThrow({ where: { provider: NAME } });
    expect(row.state).toBe("CLOSED");
    expect(row.failures).toBe(0);
  });

  it("sonda que falha reabre imediatamente", async () => {
    await failNTimes(5);
    await forceCooldownExpired();
    await expect(withBreaker(NAME, boom)).rejects.toThrow("provider fora do ar");
    const row = await db.prisma.providerCircuit.findUnique({ where: { provider: NAME } });
    expect(row?.state).toBe("OPEN");
  });

  it("sonda limitada por 429 reabre pelo cooldown completo", async () => {
    await failNTimes(5);
    await forceCooldownExpired();

    await expect(
      withBreaker(NAME, async () => {
        throw new ProviderRequestError("provider-teste", { status: 429, error: "HTTP 429" });
      }),
    ).rejects.toThrow(/429/);

    const row = await db.prisma.providerCircuit.findUniqueOrThrow({ where: { provider: NAME } });
    expect(row.state).toBe("OPEN");
    expect(row.openedAt?.getTime()).toBeGreaterThan(Date.now() - 5_000);
  });

  it("primeiro 429 abre cooldown sem consumir cinco falhas estruturais", async () => {
    await expect(
      withBreaker(NAME, async () => {
        throw new ProviderRequestError("provider-teste", { status: 429, error: "HTTP 429" });
      }),
    ).rejects.toThrow(/429/);
    const row = await db.prisma.providerCircuit.findUniqueOrThrow({ where: { provider: NAME } });
    expect(row.state).toBe("OPEN");
    expect(row.failures).toBe(5);
  });

  it("BridgeOdds respeita a janela horária antes de permitir nova sonda", async () => {
    const bridge = "bridgeodds";
    await resetBreakerForTests(bridge);
    await tripBreaker(bridge);
    await db.prisma.providerCircuit.update({
      where: { provider: bridge },
      data: { openedAt: new Date(Date.now() - 16 * 60_000) },
    });
    expect(await isBreakerOpen(bridge)).toBe(true);

    await db.prisma.providerCircuit.update({
      where: { provider: bridge },
      data: { openedAt: new Date(Date.now() - 61 * 60_000) },
    });
    expect(await isBreakerOpen(bridge)).toBe(false);
    await resetBreakerForTests(bridge);
  });

  it("primeira página de bloqueio abre cooldown imediato", async () => {
    await expect(
      withBreaker(NAME, async () => {
        throw new ProviderRequestError("provider-teste", {
          status: 502,
          error: "bloqueio anti-bot",
          blocked: true,
        });
      }),
    ).rejects.toThrow(/bloqueio anti-bot/);
    const row = await db.prisma.providerCircuit.findUniqueOrThrow({ where: { provider: NAME } });
    expect(row.state).toBe("OPEN");
  });

  it("claim da sonda é atômico: só um concorrente passa após o cooldown", async () => {
    await failNTimes(5);
    await forceCooldownExpired();

    let execucoes = 0;
    const tentativa = () =>
      withBreaker(NAME, async () => {
        execucoes += 1;
        await new Promise((r) => setTimeout(r, 50));
        return "ok";
      }).then(
        () => "passou" as const,
        (err) => (err instanceof CircuitOpenError ? ("rejeitado" as const) : Promise.reject(err)),
      );

    const resultados = await Promise.all([tentativa(), tentativa(), tentativa()]);
    expect(execucoes).toBe(1);
    expect(resultados.filter((r) => r === "passou")).toHaveLength(1);
    expect(resultados.filter((r) => r === "rejeitado")).toHaveLength(2);
  });

  it("HALF_OPEN cobre o budget real e só reassume sonda realmente abandonada", async () => {
    // Estado HALF_OPEN com sonda recém-reivindicada (lease vigente) — raw para
    // controlar updatedAt (a coluna é @updatedAt e o client sempre põe "agora").
    await db.prisma.$executeRaw`
      INSERT INTO provider_circuits (provider, state, failures, "openedAt", "updatedAt")
      VALUES (${NAME}, 'HALF_OPEN', 5, ${new Date(Date.now() - 120_000)}, ${new Date()})`;

    let chamou = false;
    await expect(
      withBreaker(NAME, async () => {
        chamou = true;
      }),
    ).rejects.toThrow(CircuitOpenError);
    expect(chamou).toBe(false); // sonda em andamento → rejeita (uma por vez)

    // A lease impede uma segunda sonda faturável enquanto a anterior aguarda resposta.
    await db.prisma
      .$executeRaw`UPDATE provider_circuits SET "updatedAt" = ${new Date(Date.now() - 60_000)} WHERE provider = ${NAME}`;
    await expect(withBreaker(NAME, async () => "não pode passar"))
      .rejects.toThrow(CircuitOpenError);

    // Acima do budget máximo + margem: processo morreu sem resolver e pode ser
    // reassumido sem prender o breaker para sempre.
    await db.prisma
      .$executeRaw`UPDATE provider_circuits SET "updatedAt" = ${new Date(Date.now() - 150_000)} WHERE provider = ${NAME}`;
    await expect(withBreaker(NAME, async () => "reassumiu")).resolves.toBe("reassumiu");
  });
});

/**
 * Quem usa `isBreakerOpen`/`tripBreaker` (Gemini) não tem o `recordSuccess` do
 * caminho envolvido, então sem este fechamento a linha ficaria OPEN para sempre
 * depois do primeiro trip, com o provider funcionando normalmente — o gate é
 * `openedAt`, não o campo `state`.
 */
describe("fechamento do breaker após sucesso (par isBreakerOpen/tripBreaker)", () => {
  async function state(): Promise<{ state: string; failures: number } | null> {
    const row = await db.prisma.providerCircuit.findUnique({ where: { provider: NAME } });
    return row ? { state: row.state, failures: row.failures } : null;
  }

  it("trip expirado vira CLOSED — a lápide para de enganar quem lê a tabela", async () => {
    await tripBreaker(NAME);
    await forceCooldownExpired();
    // Já é inofensivo pelo tempo, mas a tabela ainda mente.
    expect(await isBreakerOpen(NAME)).toBe(false);
    expect(await state()).toEqual({ state: "OPEN", failures: 5 });

    await closeExpiredBreaker(NAME);

    expect(await state()).toEqual({ state: "CLOSED", failures: 0 });
  });

  it("trip RECÉM-aberto é preservado: sucesso lento não apaga cooldown legítimo", async () => {
    await tripBreaker(NAME);

    await closeExpiredBreaker(NAME);

    // Mesma guarda do `recordSuccess`: sucesso velho não fecha breaker aberto depois.
    expect(await state()).toEqual({ state: "OPEN", failures: 5 });
    expect(await isBreakerOpen(NAME)).toBe(true);
  });

  it("OPEN legado sem openedAt também é limpo (mesma leitura de isBreakerOpen)", async () => {
    await db.prisma.$executeRaw`
      INSERT INTO provider_circuits (provider, state, failures, "openedAt", "updatedAt")
      VALUES (${NAME}, 'OPEN', 5, NULL, ${new Date()})`;
    expect(await isBreakerOpen(NAME)).toBe(false);

    await closeExpiredBreaker(NAME);

    expect(await state()).toEqual({ state: "CLOSED", failures: 0 });
  });

  it("é no-op quando já está CLOSED — não escreve por chamada bem-sucedida", async () => {
    // A linha PRECISA existir, senão o teste compara undefined com undefined e
    // passa sem exercitar nada: uma falha cria a linha, o sucesso a fecha.
    await failNTimes(1);
    await withBreaker(NAME, async () => "ok");
    const antes = await db.prisma.providerCircuit.findUniqueOrThrow({
      where: { provider: NAME },
    });
    expect(antes.state).toBe("CLOSED");

    await closeExpiredBreaker(NAME);

    const depois = await db.prisma.providerCircuit.findUniqueOrThrow({
      where: { provider: NAME },
    });
    expect(depois.updatedAt.getTime()).toBe(antes.updatedAt.getTime());
  });
});

async function breakerMetrics(): Promise<
  Array<{ outcome: string; reason: unknown; failures: unknown; cooldownMs: unknown }>
> {
  const rows = await db.prisma.operationalMetric.findMany({
    where: { name: `${NAME}.breaker` },
    orderBy: { id: "asc" },
    select: { outcome: true, labels: true },
  });
  return rows.map((row) => {
    const labels = (row.labels as Record<string, unknown> | null) ?? {};
    return {
      outcome: row.outcome,
      reason: labels.reason,
      failures: labels.failures,
      cooldownMs: labels.cooldownMs,
    };
  });
}

/**
 * A série `<provider>.breaker` mede a ABERTURA do circuito: uma amostra por
 * trip, nunca uma por chamada recusada. Gravar cada recusa transformava o
 * fan-out de settle/enrich em milhares de `error`, e o SLO alertava em cima do
 * próprio ruído.
 */
describe("telemetria da abertura do breaker", () => {
  const previousFlag = process.env.OBSERVABILITY_METRICS_IN_TEST;
  beforeAll(() => {
    process.env.OBSERVABILITY_METRICS_IN_TEST = "true";
  });
  afterAll(() => {
    if (previousFlag === undefined) delete process.env.OBSERVABILITY_METRICS_IN_TEST;
    else process.env.OBSERVABILITY_METRICS_IN_TEST = previousFlag;
  });
  beforeEach(async () => {
    await db.prisma.operationalMetric.deleteMany({ where: { name: `${NAME}.breaker` } });
  });

  it("abrir o circuito grava UMA amostra, com motivo e contagem", async () => {
    await failNTimes(5);

    expect(await breakerMetrics()).toEqual([
      { outcome: "error", reason: "consecutive_failures", failures: 5, cooldownMs: 15 * 60_000 },
    ]);
  });

  it("recusa dentro do cooldown não grava amostra", async () => {
    await failNTimes(5);

    await expect(withBreaker(NAME, async () => "nunca")).rejects.toThrow(CircuitOpenError);
    await expect(withBreaker(NAME, async () => "nunca")).rejects.toThrow(CircuitOpenError);

    expect(await breakerMetrics()).toHaveLength(1);
  });

  it("perder a corrida pela sonda não grava amostra", async () => {
    await failNTimes(5);
    await forceCooldownExpired();
    const tentativa = () => withBreaker(NAME, async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return "ok";
    }).then(
      () => "passou" as const,
      (err) => (err instanceof CircuitOpenError ? "rejeitado" as const : Promise.reject(err)),
    );

    const resultados = await Promise.all([tentativa(), tentativa(), tentativa()]);
    expect(resultados.filter((result) => result === "passou")).toHaveLength(1);
    expect(await breakerMetrics()).toHaveLength(1);
  });

  it("sonda que falha reabre o circuito e conta nova abertura", async () => {
    await failNTimes(5);
    await forceCooldownExpired();

    await expect(withBreaker(NAME, boom)).rejects.toThrow("provider fora do ar");

    const metricas = await breakerMetrics();
    expect(metricas).toHaveLength(2);
    expect(metricas[1]).toMatchObject({ outcome: "error", reason: "consecutive_failures" });
  });

  it("trip forçado (429/anti-bot) registra o motivo real", async () => {
    await tripBreaker(NAME, "rate_limited");

    expect(await breakerMetrics()).toEqual([
      { outcome: "error", reason: "rate_limited", failures: 5, cooldownMs: 15 * 60_000 },
    ]);
  });
});
