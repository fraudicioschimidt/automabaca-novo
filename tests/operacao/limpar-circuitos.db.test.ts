import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { limparCircuitosLlm } from "@/src/services/ops/limpar-circuitos";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * Lápide de modelo retirado: o circuito fica `OPEN` no banco para sempre porque
 * nada mais consulta aquele modelo — nem a autocura do `claimGate`, nem a
 * `closeExpiredBreaker` do caminho de sucesso. `isBreakerOpen` já devolve false
 * (cooldown vencido), mas o banco mente sobre o estado.
 */

const EXECUTOR = "agent:teste:por:fabricio";
const PRESO = "llm:groq:qwen/qwen3.6-27b";
const FRESCO = "llm:mistral:mistral-large";
const OUTRO_PROVIDER = "flashscore";

let db: TestDb;

beforeAll(async () => {
  db = createTestDb();
  await db.prisma.auditEvent.deleteMany({ where: { actor: EXECUTOR } });
  await db.prisma.providerCircuit.deleteMany({
    where: { provider: { in: [PRESO, FRESCO, OUTRO_PROVIDER] } },
  });
  await db.prisma.providerCircuit.create({
    data: { provider: PRESO, state: "OPEN", failures: 5, openedAt: new Date(Date.now() - 20 * 60_000) },
  });
  await db.prisma.providerCircuit.create({
    data: { provider: FRESCO, state: "OPEN", failures: 3, openedAt: new Date() },
  });
  await db.prisma.providerCircuit.create({
    data: { provider: OUTRO_PROVIDER, state: "OPEN", failures: 5, openedAt: new Date(Date.now() - 20 * 60_000) },
  });
});

afterAll(async () => {
  await db.prisma.auditEvent.deleteMany({ where: { actor: EXECUTOR } });
  await db.prisma.providerCircuit.deleteMany({
    where: { provider: { in: [PRESO, FRESCO, OUTRO_PROVIDER] } },
  });
  await db.dispose();
});

describe("limpar circuitos de LLM presos", () => {
  it("recusa executor que a revisão de escritas não reconheceria como delegado", async () => {
    for (const executor of ["agent:x:por:fabricio", "agent:-codex:por:fabricio", `agent:${"a".repeat(41)}:por:fabricio`]) {
      await expect(limparCircuitosLlm({ executor, aplicar: false })).rejects.toThrow(/agent:<nome>:por:<dono>/);
    }
  });

  it("fecha só a lápide vencida, com auditoria, e é idempotente", async () => {
    const plano = await limparCircuitosLlm({ executor: EXECUTOR, aplicar: false });
    expect(plano.aplicado).toBe(false);
    expect(plano.linhas.map((linha) => linha.provider)).toEqual([PRESO]);

    const aplicado = await limparCircuitosLlm({ executor: EXECUTOR, aplicar: true });
    expect(aplicado.aplicado).toBe(true);

    const preso = await db.prisma.providerCircuit.findUniqueOrThrow({ where: { provider: PRESO } });
    expect(preso).toMatchObject({ state: "CLOSED", failures: 0 });
    expect(preso.openedAt).toBeNull();

    // Trip fresco (cooldown em curso) e provider que não é LLM ficam intocados.
    const fresco = await db.prisma.providerCircuit.findUniqueOrThrow({ where: { provider: FRESCO } });
    expect(fresco).toMatchObject({ state: "OPEN", failures: 3 });
    const outro = await db.prisma.providerCircuit.findUniqueOrThrow({ where: { provider: OUTRO_PROVIDER } });
    expect(outro.state).toBe("OPEN");

    const auditoria = await db.prisma.auditEvent.findMany({
      where: { actor: EXECUTOR, action: "provider_circuit.close_expired" },
    });
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0]?.resourceId).toBe(PRESO);

    const segunda = await limparCircuitosLlm({ executor: EXECUTOR, aplicar: true });
    expect(segunda.linhas).toEqual([]);
  });
});
