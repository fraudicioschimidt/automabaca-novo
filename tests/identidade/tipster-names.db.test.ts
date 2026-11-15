import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  learnTipsterTeamNames,
  learnWaitingTipsterNames,
  purgeExpiredTipsterNameWaits,
  type LearnTipsterTeamNamesInput,
} from "@/src/services/teams/tipster-names";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedCatalogLink, seedTeamCard } from "../helpers/team-cards";

/**
 * O nome que o tipster usou para o time, aprendido na ficha pelo jogo ligado
 * no pareamento dos catálogos: pendente na primeira vez, confirmado quando
 * volta noutro jogo, noutra aposta e noutro dia de São Paulo. Contra Postgres
 * real.
 */

let db: TestDb;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); });

const DAY_1 = new Date("2026-09-20T22:00:00Z");
const DAY_2 = new Date("2026-09-27T22:00:00Z");

/** Um jogo Flamengo RJ × Palmeiras SP ligado ao FlashScore, com as fichas dos dois lados bem casadas nele. */
async function linkedGame(pinnacleEventId: string, kickoff: Date, options: { swapped?: boolean } = {}) {
  await seedCatalogLink(db.prisma, {
    pinnacleEventId, flashscoreMatchId: `fs-${pinnacleEventId}`, pinnacleHome: "Flamengo RJ", pinnacleAway: "Palmeiras SP",
    flashscoreHome: options.swapped ? "Palmeiras" : "Flamengo", flashscoreAway: options.swapped ? "Flamengo" : "Palmeiras",
    flashscoreHomeTeamId: options.swapped ? "fs-pal" : "fs-fla", flashscoreAwayTeamId: options.swapped ? "fs-fla" : "fs-pal",
    swapped: options.swapped ?? false, kickoff,
  });
  for (const [teamId, name, pinnacleName] of [["fs-fla", "Flamengo", "Flamengo RJ"], ["fs-pal", "Palmeiras", "Palmeiras SP"]] as const) {
    const card = await db.prisma.teamCard.findFirst({ where: { flashscoreTeamId: teamId } });
    if (card) {
      await db.prisma.teamCardEvidence.create({ data: {
        cardId: card.id, pinnacleEventId, pinnacleName, nameNorm: pinnacleName.toLowerCase(), category: "principal", leagueKey: "|",
      } });
    } else {
      await seedTeamCard(db.prisma, { flashscoreTeamId: teamId, flashscoreName: name, country: "Brazil", pinnacleNames: [{ name: pinnacleName, eventIds: [pinnacleEventId] }] });
    }
  }
}

function learn(
  pinnacleEventId: string,
  kickoff: Date,
  tipster = { home: "Mengao", away: "Verdao" },
  betId = `bet-${pinnacleEventId}`,
  pinnacle = { home: "Flamengo RJ", away: "Palmeiras SP" },
) {
  const input: LearnTipsterTeamNamesInput = { betId, pinnacleEventId, tipster, pinnacle, kickoff };
  return learnTipsterTeamNames(input);
}

const names = () => db.prisma.teamTipsterName.findMany({
  orderBy: [{ nameNorm: "asc" }, { card: { flashscoreTeamId: "asc" } }],
  select: { name: true, status: true, firstBetId: true, firstDay: true, confirmedByBetId: true, card: { select: { flashscoreTeamId: true } } },
});

describe("nome do tipster na ficha", () => {
  it("nasce pendente e confirma quando volta, na mesma ficha, noutro dia", async () => {
    await linkedGame("100", DAY_1);
    await learn("100", DAY_1);
    expect(await names()).toEqual([
      { name: "Mengao", status: "pending", firstBetId: "bet-100", firstDay: "2026-09-20", confirmedByBetId: null, card: { flashscoreTeamId: "fs-fla" } },
      { name: "Verdao", status: "pending", firstBetId: "bet-100", firstDay: "2026-09-20", confirmedByBetId: null, card: { flashscoreTeamId: "fs-pal" } },
    ]);

    await linkedGame("200", DAY_2);
    await learn("200", DAY_2);
    expect((await names()).map((row) => [row.name, row.status, row.confirmedByBetId])).toEqual([
      ["Mengao", "confirmed", "bet-200"],
      ["Verdao", "confirmed", "bet-200"],
    ]);
  });

  it("no mesmo dia de São Paulo não confirma, nem com outra aposta", async () => {
    await linkedGame("100", DAY_1);
    await learn("100", DAY_1);
    // 23h30 de São Paulo do mesmo dia: 02h30 UTC do dia seguinte.
    await linkedGame("101", new Date("2026-09-21T02:30:00Z"));
    await learn("101", new Date("2026-09-21T02:30:00Z"), undefined, "bet-outra");
    expect((await names()).map((row) => row.status)).toEqual(["pending", "pending"]);
  });

  it.each([
    ["o mesmo jogo, noutra aposta e noutro dia (jogo adiado)", "100", "bet-outra", DAY_2],
    ["a mesma aposta, noutro evento e noutro dia (a edição que refaz a identidade)", "200", "bet-100", DAY_2],
  ] as const)("%s não confirma", async (_caso, eventId, betId, kickoff) => {
    await linkedGame("100", DAY_1);
    await learn("100", DAY_1);
    if (eventId !== "100") await linkedGame(eventId, kickoff);
    await learn(eventId, kickoff, undefined, betId);
    expect((await names()).map((row) => row.status)).toEqual(["pending", "pending"]);
  });

  it("o mesmo nome pendente noutra ficha do mesmo esporte, país e categoria não deixa confirmar", async () => {
    await seedTeamCard(db.prisma, {
      flashscoreTeamId: "fs-vasco", flashscoreName: "Vasco", country: "Brazil", tipsterNames: [{ name: "Mengao", status: "pending" }],
    });
    await linkedGame("100", DAY_1);
    await learn("100", DAY_1);
    await linkedGame("200", DAY_2);
    await learn("200", DAY_2);
    expect((await names()).map((row) => [row.name, row.card.flashscoreTeamId, row.status])).toEqual([
      ["Mengao", "fs-fla", "pending"],
      ["Mengao", "fs-vasco", "pending"],
      ["Verdao", "fs-pal", "confirmed"],
    ]);
  });

  it("o mesmo nome confirmado noutro país não impede: \"Nacional\" de dois países convive", async () => {
    await seedTeamCard(db.prisma, {
      flashscoreTeamId: "fs-portugal", flashscoreName: "Flamengo Lisboa", country: "Portugal", tipsterNames: [{ name: "Mengao" }],
    });
    await linkedGame("100", DAY_1);
    await learn("100", DAY_1);
    await linkedGame("200", DAY_2);
    await learn("200", DAY_2);
    expect((await names()).map((row) => [row.name, row.card.flashscoreTeamId, row.status])).toEqual([
      ["Mengao", "fs-fla", "confirmed"],
      ["Mengao", "fs-portugal", "confirmed"],
      ["Verdao", "fs-pal", "confirmed"],
    ]);
  });

  it("os nomes da Bridge na ordem inversa da ligação são desvirados; nomes de outro jogo não ensinam", async () => {
    await linkedGame("100", DAY_1);
    await learn("100", DAY_1, { home: "Verdao", away: "Mengao" }, "bet-100", { home: "Palmeiras SP", away: "Flamengo RJ" });
    expect((await names()).map((row) => [row.name, row.card.flashscoreTeamId])).toEqual([
      ["Mengao", "fs-fla"],
      ["Verdao", "fs-pal"],
    ]);
    await db.prisma.teamTipsterName.deleteMany();
    await learn("100", DAY_1, undefined, "bet-100", { home: "Santos SP", away: "Corinthians SP" });
    expect(await names()).toEqual([]);
  });

  it("o mando trocado no FlashScore leva cada nome à ficha do seu time", async () => {
    await linkedGame("100", DAY_1, { swapped: true });
    await learn("100", DAY_1);
    expect((await names()).map((row) => [row.name, row.card.flashscoreTeamId])).toEqual([
      ["Mengao", "fs-fla"],
      ["Verdao", "fs-pal"],
    ]);
  });

  it("nome já confirmado noutra ficha não é gravado, e o conflito fica auditado", async () => {
    await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-vasco", flashscoreName: "Vasco", country: "Brazil", tipsterNames: [{ name: "Mengao" }] });
    await linkedGame("100", DAY_1);
    await learn("100", DAY_1);
    expect((await names()).map((row) => [row.name, row.card.flashscoreTeamId, row.status])).toEqual([
      ["Mengao", "fs-vasco", "confirmed"],
      ["Verdao", "fs-pal", "pending"],
    ]);
    expect(await db.prisma.auditEvent.findMany({ where: { action: "team_tipster_name.conflict" }, select: { details: true } }))
      .toEqual([{ details: expect.objectContaining({ name: "Mengao", betId: "bet-100", pinnacleEventId: "100" }) }]);
  });

  it("o nome que já casa com o da Pinnacle por regra não é gravado", async () => {
    await linkedGame("100", DAY_1);
    await learn("100", DAY_1, { home: "Flamengo", away: "Palmeiras" });
    expect(await names()).toEqual([]);
  });

  it("o nome que não nomeia um clube e o nome mais parecido com o outro time não são gravados", async () => {
    await linkedGame("100", DAY_1);
    await learn("100", DAY_1, { home: "Time 1", away: "Flamengo RJ Palmeiras" });
    expect(await names()).toEqual([]);
  });

  it("o nome tão parecido com o outro time quanto com este não é gravado", async () => {
    await linkedGame("100", DAY_1);
    await learn("100", DAY_1, { home: "Rio de Janeiro", away: "Verdao" });
    expect((await names()).map((row) => row.name)).toEqual(["Verdao"]);
  });

  it("nome que declara outra categoria não entra na ficha do time principal", async () => {
    await linkedGame("100", DAY_1);
    await learn("100", DAY_1, { home: "Mengao Sub-20", away: "Verdao" });
    expect((await names()).map((row) => row.name)).toEqual(["Verdao"]);
  });

  it.each([
    ["sem ligação do jogo", async () => {}],
    ["com a ligação em conflito", async () => {
      await linkedGame("100", DAY_1);
      await db.prisma.catalogGameLink.update({ where: { pinnacleEventId: "100" }, data: { status: "conflict" } });
    }],
    ["com dois eventos da Pinnacle17 no mesmo jogo do FlashScore", async () => {
      await linkedGame("100", DAY_1);
      await seedCatalogLink(db.prisma, {
        pinnacleEventId: "100-dobro", flashscoreMatchId: "fs-100", pinnacleHome: "Flamengo RJ", pinnacleAway: "Palmeiras SP",
        flashscoreHome: "Flamengo", flashscoreAway: "Palmeiras", flashscoreHomeTeamId: "fs-fla", flashscoreAwayTeamId: "fs-pal", kickoff: DAY_1,
      });
    }],
    ["com a ficha sem a evidência deste jogo (o lado não casou bem nele)", async () => {
      await seedCatalogLink(db.prisma, {
        pinnacleEventId: "100", flashscoreMatchId: "fs-100", pinnacleHome: "Flamengo RJ", pinnacleAway: "Palmeiras SP",
        flashscoreHome: "Flamengo", flashscoreAway: "Palmeiras", flashscoreHomeTeamId: "fs-fla", flashscoreAwayTeamId: "fs-pal", kickoff: DAY_1,
      });
      await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-fla", flashscoreName: "Flamengo", pinnacleNames: [{ name: "Flamengo RJ", eventIds: ["outro"] }] });
    }],
  ])("%s, nada é aprendido (o nome não é adivinhado)", async (_caso, preparar) => {
    await preparar();
    await learn("100", DAY_1);
    expect(await names()).toEqual([]);
  });
});

describe("o nome que espera a ligação do jogo", () => {
  async function autoBet(id: string, pinnacleEventId: string, identityStatus: "MATCHED" | "MANUAL" = "MATCHED") {
    const bankroll = await db.prisma.bankroll.upsert({ where: { slug: "espera" }, create: { nome: "Espera", slug: "espera" }, update: {} });
    await db.prisma.bet.create({ data: {
      id, bankrollId: bankroll.id, data: DAY_1, evento: "Flamengo RJ vs Palmeiras SP", esporte: "Soccer",
      mercado: "Moneyline", selecao: "Flamengo RJ", odds: 2, stake: 1,
      sportResolutionStatus: "CONFIRMED", sportResolvedAt: DAY_1,
      sharp: { create: { identityStatus, provider: "pinnacle17", providerMatchId: pinnacleEventId, confidence: 100 } },
    } });
  }

  it("a identidade sem ligação guarda a ocasião, e a rodada que liga o jogo aprende com ela", async () => {
    await autoBet("bet-espera", "100");
    await learn("100", DAY_1, undefined, "bet-espera");
    expect(await names()).toEqual([]);
    expect(await db.prisma.teamTipsterNameWait.count()).toBe(1);

    await linkedGame("100", DAY_1);
    await expect(learnWaitingTipsterNames(["100"])).resolves.toBe(1);
    expect((await names()).map((row) => [row.name, row.status, row.firstBetId])).toEqual([
      ["Mengao", "pending", "bet-espera"],
      ["Verdao", "pending", "bet-espera"],
    ]);
    expect(await db.prisma.teamTipsterNameWait.count()).toBe(0);
  });

  it("a aposta que mudou de identidade (Vincular, outro jogo) perde a espera sem ensinar", async () => {
    await autoBet("bet-manual", "100", "MANUAL");
    await learn("100", DAY_1, undefined, "bet-manual");
    await linkedGame("100", DAY_1);
    await expect(learnWaitingTipsterNames(["100"])).resolves.toBe(0);
    expect(await names()).toEqual([]);
    expect(await db.prisma.teamTipsterNameWait.count()).toBe(0);
  });

  it.each(["removida", "apagada"] as const)("a tarefa atrasada não cria espera para a aposta %s", async (change) => {
    await autoBet("bet-atrasada", "100");
    if (change === "removida") await db.prisma.bet.update({ where: { id: "bet-atrasada" }, data: { deletedAt: new Date() } });
    else await db.prisma.bet.delete({ where: { id: "bet-atrasada" } });
    await learn("100", DAY_1, undefined, "bet-atrasada");
    expect(await db.prisma.teamTipsterNameWait.count()).toBe(0);
  });

  it("a espera sai dois dias depois do jogo", async () => {
    await autoBet("bet-velha", "100");
    await learn("100", DAY_1, undefined, "bet-velha");
    await expect(purgeExpiredTipsterNameWaits(new Date(DAY_1.getTime() + 86_400_000))).resolves.toBe(0);
    await expect(purgeExpiredTipsterNameWaits(new Date(DAY_1.getTime() + 3 * 86_400_000))).resolves.toBe(1);
  });
});
