import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalizeBetForRegistration } from "@/src/services/bets/canonicalize-registration";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedTeamCard } from "../helpers/team-cards";

/**
 * Os nomes dos times que o registro grava, contra Postgres real: os do
 * tipster, trocados só pela seleção nacional escrita em português. A ficha do
 * time não troca nome na captura: o nome do post é o que ensina a ficha.
 */
let db: TestDb;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); });

describe("nomes dos times no registro", () => {
  it("a ficha do time, mesmo com o nome do tipster confirmado, não reescreve o evento nem a seleção", async () => {
    await seedTeamCard(db.prisma, {
      flashscoreTeamId: "fs-palmeiras", flashscoreName: "Palmeiras", country: "Brazil",
      pinnacleNames: [{ name: "Palmeiras SP" }], tipsterNames: [{ name: "Verdao" }],
    });
    expect(await canonicalizeBetForRegistration({
      evento: "Verdao x Santos", esporte: "Soccer", pais: "Brasil", competicao: "", mercado: "Handicap Asiático", selecao: "Verdao -0.5",
    })).toMatchObject({ evento: "Verdao x Santos", selecao: "Verdao -0.5", pais: "Brazil" });
  });

  it("seleção nacional em português ganha o nome da Pinnacle só no futebol, no evento e na seleção", async () => {
    const bet = { evento: "Brasil vs Alemanha", pais: "", competicao: "", mercado: "Moneyline", selecao: "Brasil" };
    expect(await canonicalizeBetForRegistration({ ...bet, esporte: "Soccer" }))
      .toMatchObject({ evento: "Brazil vs Germany", selecao: "Brazil" });
    expect(await canonicalizeBetForRegistration({ ...bet, esporte: "Basketball" }))
      .toMatchObject({ evento: "Brasil vs Alemanha", selecao: "Brasil" });
    // Franca, no basquete, é o clube.
    expect(await canonicalizeBetForRegistration({
      evento: "Mogi vs Franca", esporte: "Basketball", pais: "Brasil", competicao: "NBB", mercado: "Handicap", selecao: "Franca -5.5",
    })).toMatchObject({ evento: "Mogi vs Franca", selecao: "Franca -5.5" });
  });

  it("canonizar de novo não muda o que já foi canonizado", async () => {
    const first = await canonicalizeBetForRegistration({
      evento: "Brasil vs Santos", esporte: "Soccer", pais: "Brazil", competicao: "", mercado: "Empate Anula a Aposta", selecao: "Brasil DNB",
    });
    expect(first).toMatchObject({ evento: "Brazil vs Santos", mercado: "Handicap – Match", selecao: "Brazil 0" });
    expect(await canonicalizeBetForRegistration(first)).toEqual(first);
  });
});


describe("registro preserva o escopo da entrada", () => {
  it.each(["Including OT", "Incluindo Prorrogação", "Tempo Regular"])("DNB %s não perde o qualificador do mercado", async rule => {
    const bet = { evento: "Alpha vs Beta", esporte: rule === "Tempo Regular" ? "Basketball" : "Soccer", pais: "", competicao: "",
      mercado: `Draw No Bet – ${rule}`, selecao: "Alpha" };
    expect(await canonicalizeBetForRegistration(bet)).toMatchObject({ mercado: bet.mercado, selecao: bet.selecao });
  });
});


it("marcador DC não apaga prorrogação dita só no mercado genérico", async () => {
  const bet = { evento: "Alpha vs Beta", esporte: "Soccer", pais: "", competicao: "",
    mercado: "Moneyline Including OT", selecao: "Alpha DC" };
  expect(await canonicalizeBetForRegistration(bet)).toMatchObject({ mercado: bet.mercado, selecao: bet.selecao });
});


it.each(["Points", "Sets", "Games"])("registro não apaga unidade %s de DNB no futebol", async unit => {
  const bet = { evento: "Alpha vs Beta", esporte: "Soccer", pais: "", competicao: "",
    mercado: `Draw No Bet (${unit})`, selecao: "Alpha" };
  expect(await canonicalizeBetForRegistration(bet)).toMatchObject({ mercado: bet.mercado, selecao: bet.selecao });
});
