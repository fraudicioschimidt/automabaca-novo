import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getTrilhaDaAposta } from "@/src/services/painel/aposta/trilha";
import { narrar, type EventoBruto } from "@/src/domain/trilha-da-aposta";
import { createTestDb, type TestDb } from "../helpers/db";

/** Só o texto da narração, sem a marcação. */
const fraseSimples = (evento: EventoBruto): string =>
  narrar(evento).frase.map((t) => t.texto).join("");

/**
 * A trilha contra Postgres real — é onde a fusão das DUAS tabelas pode mentir.
 *
 * Teste puro não pega o que aqui importa: nome de coluna, o filtro
 * `resource='bet'`, `type='STATUS_CHANGED'`, e sobretudo a ORDEM, que decide se
 * o operador lê "reembolso virou perdida" ou o contrário. Settlement é
 * financeiro, e financeiro testa contra banco de verdade.
 */

let db: TestDb;

beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); });

async function apostaComHistoria() {
  const banca = await db.prisma.bankroll.upsert({
    where: { slug: "trilha" },
    create: { nome: "Trilha", slug: "trilha" },
    update: {},
  });
  const bet = await db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      bankrollId: banca.id,
      data: new Date("2026-08-10T18:00:00Z"),
      evento: "Magallanes vs Cobreloa",
      esporte: "Soccer",
      mercado: "Asian Handicap",
      selecao: "Cobreloa +0.5",
      odds: 1.95,
      stake: 1,
    },
  });
  const em = (iso: string) => new Date(iso);

  await db.prisma.auditEvent.createMany({
    data: [
      {
        actor: "telegram-channel:gemini-vision", action: "bet.create",
        resource: "bet", resourceId: bet.id, createdAt: em("2026-08-10T12:00:00Z"),
        details: { odds: 1.95, stake: 1, mercado: "Asian Handicap", selecao: "Cobreloa +0.5" },
      },
      {
        actor: "system", action: "identidade_llm",
        resource: "bet", resourceId: bet.id, createdAt: em("2026-08-10T12:05:00Z"),
        details: { via: "LLM", match: "Magallanes vs Cobreloa", confidence: 71, providerMatchId: "999" },
      },
      {
        actor: "system", action: "kickoff.resolve_attempt",
        resource: "bet", resourceId: bet.id, createdAt: em("2026-08-10T12:10:00Z"),
        details: {
          source: "bridge", aplicado: true,
          anterior: "2026-08-10T17:00:00.000Z", resolvido: "2026-08-10T19:00:00.000Z",
        },
      },
      // Ruído que a trilha NÃO narra: outro recurso, e uma action fora do
      // vocabulário. Nenhuma das duas pode virar linha.
      {
        actor: "system", action: "telegram.parse",
        resource: "-1003760086340", resourceId: "m1", createdAt: em("2026-08-10T12:01:00Z"),
        details: {},
      },
      {
        actor: "system", action: "observability.slo_breach",
        resource: "bet", resourceId: bet.id, createdAt: em("2026-08-10T12:02:00Z"),
        details: {},
      },
    ],
  });

  await db.prisma.settlementEvent.createMany({
    data: [
      {
        betId: bet.id, type: "STATUS_CHANGED", payloadHash: "h1",
        createdAt: em("2026-08-10T21:00:00Z"),
        payload: { from: "PENDING", to: "VOID", lucro: 0, source: "flashscore" },
      },
      {
        betId: bet.id, type: "STATUS_CHANGED", payloadHash: "h2",
        createdAt: em("2026-08-12T19:12:00Z"),
        payload: { from: "VOID", to: "LOST", lucro: -2, source: "manual:new-bot:recalc-ah-live" },
      },
    ],
  });
  return bet;
}

describe("trilha da aposta contra o banco", () => {
  it("funde as duas tabelas, mais novo primeiro", async () => {
    const bet = await apostaComHistoria();
    const { linhas } = await getTrilhaDaAposta(bet.id);

    expect(linhas.map((l) => l.chave)).toEqual([
      "reliquidacao",      // 12/08 19:12
      "liquidacao",        // 10/08 21:00
      "kickoff_corrigido", // 10/08 12:10
      "identidade_llm",    // 10/08 12:05
      "captura",           // 10/08 12:00
    ]);
  });

  it("o que a trilha não sabe narrar não vira linha muda", async () => {
    const bet = await apostaComHistoria();
    const { linhas } = await getTrilhaDaAposta(bet.id);
    // 5 audit_events gravados (2 fora do vocabulário/recurso) + 2 settlement.
    expect(linhas).toHaveLength(5);
  });

  it("o caso que motivou a rodada se lê inteiro", async () => {
    const bet = await apostaComHistoria();
    const { linhas, reliquidada } = await getTrilhaDaAposta(bet.id);
    const [primeira] = linhas;

    expect(reliquidada).toBe(true);
    expect(fraseSimples({
      chave: primeira!.chave, em: new Date(primeira!.em), ator: primeira!.ator,
      outcome: "success",
      dados: { from: "VOID", to: "LOST", lucro: -2, source: "manual:new-bot:recalc-ah-live" },
    })).toBe(
      "Resultado alterado de reembolso para perdida por ação manual "
      + "(new-bot:recalc-ah-live) — o ledger passou a -2.00u.",
    );
  });

  it("aposta só liquidada NÃO conta como re-liquidada", async () => {
    const banca = await db.prisma.bankroll.upsert({
      where: { slug: "trilha2" }, create: { nome: "T2", slug: "trilha2" }, update: {},
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: banca.id, data: new Date("2026-08-11T18:00:00Z"),
        evento: "A vs B", esporte: "Soccer", mercado: "Moneyline", selecao: "Casa",
        odds: 2, stake: 1,
      },
    });
    await db.prisma.settlementEvent.create({
      data: {
        betId: bet.id, type: "STATUS_CHANGED", payloadHash: "h",
        payload: { from: "PENDING", to: "WON", lucro: 1, source: "flashscore" },
      },
    });

    const { reliquidada, linhas } = await getTrilhaDaAposta(bet.id);
    expect(reliquidada).toBe(false);
    expect(linhas.map((l) => l.chave)).toEqual(["liquidacao"]);
  });

  it("sem a gênese, a trilha se DECLARA incompleta em vez de parecer curta", async () => {
    const bet = await apostaComHistoria();
    // A purga levaria justamente o `bet.create` primeiro (é o mais antigo).
    await db.prisma.auditEvent.deleteMany({
      where: { resource: "bet", resourceId: bet.id, action: "bet.create" },
    });

    const truncada = await getTrilhaDaAposta(bet.id);
    expect(truncada.completa).toBe(false);
    expect(truncada.comecaEm).toBe(new Date("2026-08-10T12:05:00Z").toISOString());
    expect(truncada.retencaoDias).toBe(365);

    const inteira = await getTrilhaDaAposta((await apostaComHistoria()).id);
    expect(inteira.completa).toBe(true);
    expect(inteira.comecaEm).toBe(null);
  });

  it("aposta sem nenhum evento devolve lista vazia, não erro", async () => {
    const banca = await db.prisma.bankroll.upsert({
      where: { slug: "trilha3" }, create: { nome: "T3", slug: "trilha3" }, update: {},
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: banca.id, data: new Date(), evento: "X vs Y", esporte: "Soccer",
        mercado: "Moneyline", selecao: "Casa", odds: 2, stake: 1,
      },
    });
    const t = await getTrilhaDaAposta(bet.id);
    expect(t.linhas).toEqual([]);
    // Sem evento nenhum não há o que declarar truncado.
    expect(t.completa).toBe(false);
    expect(t.comecaEm).toBe(null);
  });
});


describe("autoria e reabertura na trilha", () => {
  it.each([
    ["manual:fabricio", "fabricio"],
    ["ia-judge:agent:codex:por:fabricio", "🤖 Codex (por Fabricio)"],
    ["flashscore", "system"],
  ])("preserva a autoria de %s", async (source, actor) => {
    const bet = await apostaComHistoria();
    const event = await db.prisma.settlementEvent.create({ data: { betId: bet.id, type: "STATUS_CHANGED",
      payloadHash: source, payload: { from: "LOST", to: "WON", lucro: 1, source } } });
    const trail = await getTrilhaDaAposta(bet.id);
    expect(trail.linhas.find((line) => line.id === event.id)?.ator).toBe(actor);
  });

  it("narra a reabertura como volta a pendente, sem afirmar nova liquidação", async () => {
    const bet = await apostaComHistoria();
    await db.prisma.settlementEvent.deleteMany({ where: { betId: bet.id } });
    await db.prisma.settlementEvent.create({ data: { betId: bet.id, type: "STATUS_CHANGED", payloadHash: "reopen",
      payload: { from: "WON", to: "PENDING", lucro: 0, source: "manual:fabricio" } } });
    const trail = await getTrilhaDaAposta(bet.id);
    const line = trail.linhas[0];
    expect(line?.chave).toBe("reabertura");
    expect(line?.frase.map((part) => part.texto).join("")).toContain("Reaberta");
    // A marca sinaliza mudança após liquidar, incluindo reabertura, pela regra única do banco.
    expect(trail.reliquidada).toBe(true);
  });
});
