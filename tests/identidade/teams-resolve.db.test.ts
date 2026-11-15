import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyTeamAliases } from "@/src/services/sharp/enrich/identity-cache";
import { resolveTeamsForProvider } from "@/src/services/teams/resolve";
import { TEAM_PROVIDERS } from "@/src/services/teams/types";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedTeamCard } from "../helpers/team-cards";

/**
 * A tradução do nome da aposta pelas fichas dos times, contra Postgres real:
 * pelo nome de tipster confirmado, pelo nome da Pinnacle17 (2 jogos) e pelo do
 * FlashScore. Nome com mais de uma ficha não traduz; sem ficha, fica como veio.
 */

let db: TestDb;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); });

const BRASILEIRAO = { sport: "Soccer", pais: "Brazil", competicao: "Brazil - Serie A" };

async function palmeiras(options: { tipster?: "pending" | "confirmed" } = {}) {
  return seedTeamCard(db.prisma, {
    flashscoreTeamId: "fs-pal", flashscoreName: "Palmeiras", country: "Brazil",
    pinnacleNames: [{ name: "Palmeiras SP" }],
    tipsterNames: options.tipster ? [{ name: "Verdao", status: options.tipster }] : [],
  });
}

const translate = (home: string, away: string, provider: (typeof TEAM_PROVIDERS)[keyof typeof TEAM_PROVIDERS] = TEAM_PROVIDERS.PINNACLE17, context = BRASILEIRAO) =>
  resolveTeamsForProvider({ home, away }, provider, context);

describe("tradução pelas fichas", () => {
  it("o nome de tipster confirmado dá o nome da Pinnacle e, para o FlashScore, o nome e o id dele", async () => {
    const cardId = await palmeiras({ tipster: "confirmed" });

    await expect(translate("Verdao", "Santos")).resolves.toMatchObject({
      home: "Palmeiras SP", away: "Santos",
      homeResolution: { strategy: "tipster_name", cardId, providerTeamId: null },
      awayResolution: { strategy: "original", cardId: null },
    });
    await expect(translate("Verdao", "Santos", TEAM_PROVIDERS.FLASHSCORE)).resolves.toMatchObject({
      home: "Palmeiras", homeResolution: { strategy: "tipster_name", providerTeamId: "fs-pal" },
    });
  });

  it("o nome de tipster pendente não traduz", async () => {
    await palmeiras({ tipster: "pending" });
    await expect(translate("Verdao", "Santos")).resolves.toMatchObject({
      home: "Verdao", homeResolution: { strategy: "original", cardId: null },
    });
  });

  it("o nome da Pinnacle traduz com 2 jogos distintos, não com 1", async () => {
    await palmeiras();
    await seedTeamCard(db.prisma, {
      flashscoreTeamId: "fs-san", flashscoreName: "Santos FC", country: "Brazil", pinnacleNames: [{ name: "Santos SP", games: 1 }],
    });

    await expect(translate("Palmeiras SP", "Santos SP", TEAM_PROVIDERS.FLASHSCORE)).resolves.toMatchObject({
      home: "Palmeiras", away: "Santos SP",
      homeResolution: { strategy: "pinnacle_name", providerTeamId: "fs-pal" },
      awayResolution: { strategy: "original" },
    });
  });

  it("o nome do FlashScore acha a ficha, e a Pinnacle recebe o nome mais recente dela", async () => {
    await seedTeamCard(db.prisma, {
      flashscoreTeamId: "fs-york", flashscoreName: "Inter Toronto", country: "Canada",
      pinnacleNames: [{ name: "York United" }, { name: "Inter Toronto FC" }],
    });

    await expect(translate("Inter Toronto", "Forge", TEAM_PROVIDERS.PINNACLE, { sport: "Soccer", pais: "Canada", competicao: "Canadian Premier League" }))
      .resolves.toMatchObject({
        home: "Inter Toronto FC",
        homeResolution: { strategy: "flashscore_name", alternativeNames: ["York United", "Inter Toronto"] },
      });
  });

  it("a ficha achada pelo nome do FlashScore ou de tipster dá o nome da Pinnacle mesmo visto num jogo só", async () => {
    const cardId = await seedTeamCard(db.prisma, {
      flashscoreTeamId: "fs-cuiaba", flashscoreName: "Cuiaba", country: "Brazil",
      pinnacleNames: [{ name: "Cuiaba MT", games: 1 }], tipsterNames: [{ name: "Dourado" }],
    });
    await expect(translate("Cuiaba", "Santos")).resolves.toMatchObject({
      home: "Cuiaba MT", homeResolution: { strategy: "flashscore_name", cardId },
    });
    await expect(translate("Dourado", "Santos")).resolves.toMatchObject({
      home: "Cuiaba MT", homeResolution: { strategy: "tipster_name", cardId },
    });
    // Pelo nome da Pinnacle visto num jogo só, a ficha não é achada.
    await expect(translate("Cuiaba MT", "Santos")).resolves.toMatchObject({ homeResolution: { strategy: "original" } });
  });

  it("a ficha sem nome nenhum da Pinnacle não traduz para a Pinnacle, mas a conhece", async () => {
    const cardId = await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-cuiaba", flashscoreName: "Cuiaba", country: "Brazil" });
    await expect(translate("Cuiaba", "Santos")).resolves.toMatchObject({
      home: "Cuiaba", homeResolution: { strategy: "card_only", cardId },
    });
  });

  it("nome genérico não traduz sem país e competição, por nenhuma rota", async () => {
    await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-racing", flashscoreName: "Racing", country: "Argentina", pinnacleNames: [{ name: "Racing" }] });
    await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-inter", flashscoreName: "Inter", country: "Italy", pinnacleNames: [{ name: "Inter" }] });
    const semContexto = { sport: "Soccer", pais: "", competicao: "" };
    await expect(translate("Racing", "Inter", TEAM_PROVIDERS.FLASHSCORE, semContexto)).resolves.toMatchObject({
      homeResolution: { strategy: "original", providerTeamId: null }, awayResolution: { strategy: "original", providerTeamId: null },
    });
    await expect(translate("Racing", "Boca", TEAM_PROVIDERS.FLASHSCORE, { sport: "Soccer", pais: "Argentina", competicao: "Argentina - Liga Profesional" }))
      .resolves.toMatchObject({ homeResolution: { strategy: "pinnacle_name", providerTeamId: "fs-racing" } });
  });

  it("sem esporte conhecido, nada traduz", async () => {
    await palmeiras({ tipster: "confirmed" });
    await expect(translate("Verdao", "Santos", TEAM_PROVIDERS.PINNACLE17, { ...BRASILEIRAO, sport: "Unknown" }))
      .resolves.toMatchObject({ home: "Verdao", homeResolution: { strategy: "original" } });
    await expect(translate("Verdao", "Santos", TEAM_PROVIDERS.PINNACLE17, { ...BRASILEIRAO, sport: "" }))
      .resolves.toMatchObject({ home: "Verdao", homeResolution: { strategy: "original" } });
  });

  it("homônimos: o país da aposta escolhe a ficha; sem país, não traduz", async () => {
    for (const [country, id] of [["Argentina", "fs-hur-arg"], ["Uruguay", "fs-hur-uru"]] as const) {
      await seedTeamCard(db.prisma, { flashscoreTeamId: id, flashscoreName: "Huracan", country, pinnacleNames: [{ name: `Huracan ${country}` }] });
    }

    await expect(translate("Huracan", "Velez", TEAM_PROVIDERS.FLASHSCORE, { sport: "Soccer", pais: "Argentina", competicao: "Liga Profesional" }))
      .resolves.toMatchObject({ home: "Huracan", homeResolution: { strategy: "flashscore_name", providerTeamId: "fs-hur-arg" } });
    await expect(translate("Huracan", "Velez", TEAM_PROVIDERS.FLASHSCORE, { sport: "Soccer", pais: "", competicao: "" }))
      .resolves.toMatchObject({ home: "Huracan", homeResolution: { strategy: "ambiguous", providerTeamId: null } });
  });

  it("a categoria da aposta escolhe entre a ficha do principal e a do feminino", async () => {
    await seedTeamCard(db.prisma, { flashscoreTeamId: "fs-che", flashscoreName: "Chelsea", country: "England", pinnacleNames: [{ name: "Chelsea" }] });
    await seedTeamCard(db.prisma, {
      flashscoreTeamId: "fs-che-w", flashscoreName: "Chelsea W", country: "England", category: "feminino", pinnacleNames: [{ name: "Chelsea" }],
    });
    const women = { sport: "Soccer", pais: "England", competicao: "England - Women's Super League" };
    const men = { sport: "Soccer", pais: "England", competicao: "England - Premier League" };

    await expect(translate("Chelsea", "Arsenal", TEAM_PROVIDERS.FLASHSCORE, women))
      .resolves.toMatchObject({ homeResolution: { providerTeamId: "fs-che-w" } });
    await expect(translate("Chelsea", "Arsenal", TEAM_PROVIDERS.FLASHSCORE, men))
      .resolves.toMatchObject({ homeResolution: { providerTeamId: "fs-che" } });
  });

  it("a mesma ficha nos dois lados não é um jogo: nenhum dos dois traduz", async () => {
    await seedTeamCard(db.prisma, {
      flashscoreTeamId: "fs-pal", flashscoreName: "Palmeiras", country: "Brazil",
      pinnacleNames: [{ name: "Palmeiras SP" }], tipsterNames: [{ name: "Verdao" }],
    });
    await expect(translate("Verdao", "Palmeiras SP")).resolves.toMatchObject({
      home: "Verdao", away: "Palmeiras SP",
      homeResolution: { strategy: "ambiguous" }, awayResolution: { strategy: "ambiguous" },
    });
  });

  it("nome genérico de tipster só traduz com o país e a competição da aposta", async () => {
    await seedTeamCard(db.prisma, {
      flashscoreTeamId: "fs-scp", flashscoreName: "Sporting CP", country: "Portugal",
      pinnacleNames: [{ name: "Sporting CP" }], tipsterNames: [{ name: "Sporting" }],
    });
    await expect(translate("Sporting", "Benfica", TEAM_PROVIDERS.PINNACLE17, { sport: "Soccer", pais: "", competicao: "" }))
      .resolves.toMatchObject({ home: "Sporting", homeResolution: { strategy: "original" } });
    await expect(translate("Sporting", "Benfica", TEAM_PROVIDERS.PINNACLE17, { sport: "Soccer", pais: "Portugal", competicao: "Portugal - Primeira Liga" }))
      .resolves.toMatchObject({ home: "Sporting CP", homeResolution: { strategy: "tipster_name" } });
  });

  it("sem ficha, a Pinnacle recebe a seleção nacional pelo mapa fixo, só no futebol", async () => {
    await expect(applyTeamAliases({ home: "Espanha", away: "Itália" }, "Soccer", "", ""))
      .resolves.toMatchObject({ home: "Spain", away: "Italy" });
    await expect(applyTeamAliases({ home: "Franca", away: "Mogi" }, "Basketball", "Brazil", "NBB"))
      .resolves.toMatchObject({ home: "Franca", away: "Mogi" });
  });
});
