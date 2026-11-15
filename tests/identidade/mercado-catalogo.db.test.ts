import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { checkMercadoForaDoCatalogo } from "@/src/services/ops/consistency/mercado-catalogo";
import { adicionarMercadoAlias } from "@/src/services/mercados/aliases";
import { seedMercados } from "@/prisma/seed-mercados";

let db: TestDb;
let seq = 0;

beforeAll(() => {
  db = createTestDb();
});

afterAll(async () => {
  await db.dispose();
});

beforeEach(async () => {
  await db.reset();
});

/**
 * Todo mercado gravado tem que estar no vocabulário Pinnacle.
 *
 * O `⚠️ mercado não reconhecido` na confirmação do Telegram é mensagem que rola
 * e some, e a aposta fica com o nome cru sem ninguém ver. O check transforma o
 * desvio em ação operacional, que fica na fila até alguém resolver.
 */
describe("checkMercadoForaDoCatalogo (Postgres real)", () => {
  async function seedMercado(mercado: string, esporte = "Soccer") {
    seq += 1;
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: `Banca M${seq}`, slug: `banca-m${seq}`, valorUnidade: 100 },
    });
    return db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: bankroll.id,
        data: new Date("2026-08-01T16:00:00Z"),
        evento: "Time A vs Time B",
        esporte,
        mercado,
        selecao: "Over 2.5",
        odds: 1.9,
        stake: 1,
        status: "PENDING",
        lucro: 0,
      },
    });
  }

  it("mercado do catálogo não diverge", async () => {
    await seedMercado("Handicap – Match");
    await seedMercado("Total Points", "Basketball");
    await seedMercado("Total (Shots) – Match");
    const r = await checkMercadoForaDoCatalogo();
    expect(r.divergentes).toEqual([]);
  });

  it("contrato de jogador em identidade e total de pontos do time não exigem alias Pinnacle", async () => {
    const prop = await seedMercado("Player Shots");
    await db.prisma.bankroll.update({ where: { id: prop.bankrollId }, data: { sharpMode: "IDENTITY_ONLY" } });
    await db.prisma.bet.update({ where: { id: prop.id }, data: { selecao: "Tom Fellows Over 1.5" } });
    const team = await seedMercado("Team Total (Points)", "Basketball");
    await db.prisma.bet.update({ where: { id: team.id }, data: { selecao: "Time B Over 70.5" } });
    expect((await checkMercadoForaDoCatalogo()).divergentes).toEqual([]);
    await db.prisma.bet.update({ where: { id: prop.id }, data: { selecao: "Tom Fellows" } });
    expect((await checkMercadoForaDoCatalogo()).divergentes.map((d) => d.betId)).toEqual([prop.id]);
  });

  it("esporte pendente é tratado pela resolução de identidade antes da taxonomia", async () => {
    const bet = await seedMercado("Asian Handicap");
    await db.prisma.bet.update({ where: { id: bet.id }, data: { esporte: "Unknown", sportResolutionStatus: "PENDING", sportResolvedAt: null } });
    expect((await checkMercadoForaDoCatalogo()).divergentes).toEqual([]);
  });

  it("preserva props individuais de eSports e continua apontando totais de time rotulados como jogador", async () => {
    const bet = await seedMercado("Player Props", "eSports");
    await db.prisma.bet.update({ where: { id: bet.id }, data: { evento: "9Z vs G2", selecao: "HUASOPEEK Under 8.5 kills map 1 HT" } });
    expect((await checkMercadoForaDoCatalogo()).divergentes).toEqual([]);
    await db.prisma.bet.update({ where: { id: bet.id }, data: { selecao: "G2 Under 8.5 kills map 1 HT" } });
    expect((await checkMercadoForaDoCatalogo()).divergentes.map((d) => d.betId)).toEqual([bet.id]);
  });

  it("hífen no lugar do travessão é o MESMO mercado, não divergência", async () => {
    await seedMercado("Handicap - Match");
    const r = await checkMercadoForaDoCatalogo();
    expect(r.divergentes).toEqual([]);
  });

  it("grafia crua é detectada e vem com o alvo já resolvido", async () => {
    const bet = await seedMercado("Ambos Marcam");
    const r = await checkMercadoForaDoCatalogo();
    expect(r.divergentes).toHaveLength(1);
    expect(r.divergentes[0]).toMatchObject({
      betId: bet.id,
      mercadoGravado: "Ambos Marcam",
      mercadoSugerido: "Both Teams to Score",
    });
  });

  it("Goal Line gravada aponta para Total – Match, não some no silêncio", async () => {
    const bet = await seedMercado("Goal Line");
    const r = await checkMercadoForaDoCatalogo();
    expect(r.divergentes).toEqual([
      expect.objectContaining({
        betId: bet.id,
        mercadoGravado: "Goal Line",
        mercadoSugerido: "Total – Match",
      }),
    ]);
  });

  /**
   * A sugestão é a do registro (o catálogo do banco), e a saída é editar a
   * aposta: a edição renormaliza o mercado, o reprocessamento não.
   */
  it("alias cadastrado depois da captura vira a sugestão, e a ação manda editar", async () => {
    await seedMercados(db.prisma);
    const moneyline = await db.prisma.mercadoPadrao.findUniqueOrThrow({ where: { nome: "Money Line – Match" } });
    await adicionarMercadoAlias({ mercadoPadraoId: moneyline.id, alias: "Vencedor do Confronto", actor: "operador" }, { client: db.prisma });
    const bet = await seedMercado("Vencedor do Confronto");

    const r = await checkMercadoForaDoCatalogo();

    expect(r.divergentes).toEqual([
      expect.objectContaining({ betId: bet.id, mercadoSugerido: "Money Line – Match" }),
    ]);
    const action = await db.prisma.operationalAction.findFirstOrThrow({ where: { resource: "bet", resourceId: bet.id } });
    expect(action.description).toContain("edite a aposta");
    expect(action.description).not.toContain("reprocess");
  });

  it("alias que o dono removeu do banco não vira sugestão", async () => {
    await seedMercados(db.prisma);
    await db.prisma.mercadoAlias.deleteMany({ where: { aliasNormalizado: "resultado final", casaDeAposta: "" } });
    const bet = await seedMercado("Resultado Final");

    const r = await checkMercadoForaDoCatalogo();

    expect(r.divergentes).toEqual([expect.objectContaining({ betId: bet.id, mercadoSugerido: null })]);
  });

  it("sem alias que resolva, avisa mesmo assim — com sugestão nula", async () => {
    await seedMercado("Mercado Que Ninguem Cadastrou");
    const r = await checkMercadoForaDoCatalogo();
    expect(r.divergentes).toHaveLength(1);
    expect(r.divergentes[0]?.mercadoSugerido).toBeNull();
  });

  /**
   * O intermediário resolve por esporte, então gravá-lo perderia a distinção
   * que a probation usa como chave de segmento (Total futebol ≠ Total basquete).
   */
  it("intermediário gravado numa aposta é divergência, não mercado válido", async () => {
    await seedMercado("Total");
    const r = await checkMercadoForaDoCatalogo();
    expect(r.divergentes).toHaveLength(1);
    expect(r.divergentes[0]?.mercadoSugerido).toBe("Total – Match");
  });

  it("aposta apagada não entra na conta", async () => {
    const bet = await seedMercado("Ambos Marcam");
    await db.prisma.bet.update({ where: { id: bet.id }, data: { deletedAt: new Date() } });
    const r = await checkMercadoForaDoCatalogo();
    expect(r.divergentes).toEqual([]);
  });

  it("NUNCA corrige sozinho — nome de mercado é chave de segmento", async () => {
    const bet = await seedMercado("Ambos Marcam");
    await checkMercadoForaDoCatalogo();
    const depois = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(depois.mercado).toBe("Ambos Marcam");
  });
});
