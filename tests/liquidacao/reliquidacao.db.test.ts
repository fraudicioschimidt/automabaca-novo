import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { apostasReliquidadas, getResumoDeReliquidacao } from "@/src/services/painel/aposta/reliquidacao";
import { getTrilhaDaAposta } from "@/src/services/painel/aposta/trilha";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * "Resultado trocado depois de liquidada" é decidido num lugar só: a função
 * `settlement_event_is_resettlement(type, payload)` do banco. A lista da banca
 * e Operações filtram por ela, e a ficha lê o resultado dela na consulta dos
 * eventos. Estes testes fixam a regra nos casos de borda e provam que as três
 * leituras seguem a função, sem regra própria.
 */

let db: TestDb;

beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); });

async function apostaCom(from: string, slug: string) {
  const banca = await db.prisma.bankroll.upsert({
    where: { slug }, create: { nome: slug, slug }, update: {},
  });
  const bet = await db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      bankrollId: banca.id, data: new Date("2026-08-11T18:00:00Z"),
      evento: `Caso ${slug}`, esporte: "Soccer", mercado: "Moneyline", selecao: "Casa",
      odds: 2, stake: 1,
    },
  });
  await db.prisma.settlementEvent.create({
    data: {
      betId: bet.id, type: "STATUS_CHANGED", payloadHash: `h-${slug}`,
      payload: { from, to: "LOST", lucro: -1, source: "flashscore" },
    },
  });
  return bet.id;
}

describe("settlement_event_is_resettlement: a regra da reliquidação, no banco", () => {
  it.each([
    { caso: "from ausente", type: "STATUS_CHANGED", payload: { to: "LOST" }, reliquida: false },
    { caso: "from nulo", type: "STATUS_CHANGED", payload: { from: null, to: "LOST" }, reliquida: false },
    { caso: "saindo de PENDING", type: "STATUS_CHANGED", payload: { from: "PENDING", to: "LOST" }, reliquida: false },
    { caso: "saindo de VOID", type: "STATUS_CHANGED", payload: { from: "VOID", to: "LOST" }, reliquida: true },
    { caso: "saindo de WON", type: "STATUS_CHANGED", payload: { from: "WON", to: "HALF_WON" }, reliquida: true },
    { caso: "outro tipo de evento", type: "PLAYER_PROP_VALIDATION", payload: { from: "WON" }, reliquida: false },
  ])("$caso → $reliquida", async ({ type, payload, reliquida }) => {
    const [linha] = await db.prisma.$queryRaw<Array<{ reliquida: boolean }>>`
      SELECT settlement_event_is_resettlement(${type}::text, ${JSON.stringify(payload)}::jsonb) AS reliquida
    `;
    expect(linha?.reliquida).toBe(reliquida);
  });

  /** O que a lista da banca, Operações e a ficha dizem desta aposta. */
  async function leituras(betId: string) {
    const trilha = await getTrilhaDaAposta(betId);
    return {
      lista: (await apostasReliquidadas([betId])).has(betId),
      operacoes: (await getResumoDeReliquidacao(new Date("2026-01-01T00:00:00Z"))).apostas,
      ficha: trilha.reliquidada,
      linha: trilha.linhas.find((l) => l.chave === "liquidacao" || l.chave === "reliquidacao")?.chave,
    };
  }

  it("a lista, Operações e a ficha seguem a função, sem regra própria", async () => {
    const betId = await apostaCom("PENDING", "segue");
    expect(await leituras(betId)).toEqual({ lista: false, operacoes: 0, ficha: false, linha: "liquidacao" });

    // Com outra regra no banco, as três leituras mudam juntas. A definição
    // original volta no fim: o banco é do arquivo inteiro.
    const [original] = await db.prisma.$queryRaw<Array<{ def: string }>>`
      SELECT pg_get_functiondef('settlement_event_is_resettlement(text, jsonb)'::regprocedure) AS def
    `;
    try {
      await db.prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION settlement_event_is_resettlement(event_type text, payload jsonb)
        RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT event_type = 'STATUS_CHANGED' $$
      `);
      expect(await leituras(betId)).toEqual({ lista: true, operacoes: 1, ficha: true, linha: "reliquidacao" });
    } finally {
      await db.prisma.$executeRawUnsafe(original!.def);
    }
    expect(await leituras(betId)).toEqual({ lista: false, operacoes: 0, ficha: false, linha: "liquidacao" });
  });

  it("o resumo conta APOSTAS, não eventos — uma aposta pode oscilar duas vezes", async () => {
    const banca = await db.prisma.bankroll.upsert({
      where: { slug: "osc" }, create: { nome: "Osc", slug: "osc" }, update: {},
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: banca.id, data: new Date("2026-08-05T18:00:00Z"),
        evento: "Gremio vs Mirassol", esporte: "Soccer", mercado: "Asian Handicap",
        selecao: "Mirassol +0", odds: 1.9, stake: 2,
      },
    });
    // O caso REAL da produção: liquidou, virou reembolso, e o recalc virou perdida.
    await db.prisma.settlementEvent.createMany({
      data: [
        {
          betId: bet.id, type: "STATUS_CHANGED", payloadHash: "a",
          createdAt: new Date("2026-08-05T21:35:00Z"),
          payload: { from: "PENDING", to: "LOST", lucro: -2, source: "flashscore" },
        },
        {
          betId: bet.id, type: "STATUS_CHANGED", payloadHash: "b",
          createdAt: new Date("2026-08-05T22:12:00Z"),
          payload: { from: "LOST", to: "VOID", lucro: 0, source: "telegram-edit" },
        },
        {
          betId: bet.id, type: "STATUS_CHANGED", payloadHash: "c",
          createdAt: new Date("2026-08-12T19:12:00Z"),
          payload: { from: "VOID", to: "LOST", lucro: -2, source: "manual:new-bot:recalc-ah-live" },
        },
      ],
    });

    const resumo = await getResumoDeReliquidacao(new Date("2026-08-01T00:00:00Z"));
    expect(resumo.apostas).toBe(1);
    expect(resumo.eventos).toBe(2);
    expect(resumo.recentes[0]).toMatchObject({
      // A fonte chega em PROSA: o cartão é client component e não deve
      // importar o vocabulário da trilha só para traduzir uma string.
      betId: bet.id, de: "VOID", para: "LOST", fonte: "ação manual (new-bot:recalc-ah-live)",
    });
  });

  it("aposta excluída sai do resumo — não há decisão a tomar sobre ela", async () => {
    const betId = await apostaCom("VOID", "excluida");
    await db.prisma.bet.update({ where: { id: betId }, data: { deletedAt: new Date() } });

    const resumo = await getResumoDeReliquidacao(new Date("2026-08-01T00:00:00Z"));
    expect(resumo.apostas).toBe(0);
    // O SET não filtra soft-delete de propósito: quem pergunta já tem os ids
    // da tela, e a tela já filtrou. Filtrar duas vezes esconde divergência.
    expect((await apostasReliquidadas([betId])).has(betId)).toBe(true);
  });

  it("janela vazia e lista vazia não custam consulta nem erram", async () => {
    expect((await apostasReliquidadas([])).size).toBe(0);
    const resumo = await getResumoDeReliquidacao(new Date("2027-01-01T00:00:00Z"));
    expect(resumo).toEqual({ apostas: 0, eventos: 0, recentes: [] });
  });
});
