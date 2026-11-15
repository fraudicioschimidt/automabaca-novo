import { describe, expect, it } from "vitest";
import { BetStatus } from "@/src/generated/prisma/enums";
import {
  foldLegStatuses,
  isMultiFixtureTicket,
  parseBetLegs,
} from "@/src/domain/bet-legs";
import { marketIncludesExtraTime, marketPeriodOf } from "@/src/domain/mercados/classify";

describe("parseBetLegs", () => {
  it("separa dupla Target com dois jogos e duas entradas", () => {
    const ticket = parseBetLegs(
      "Mogi das Cruzes x Bauru/ Bayamon x Aguadas",
      "Mogi ML HT FT / Bayamon ML",
    );
    expect(ticket?.kind).toBe("parlay");
    expect(ticket?.legs).toEqual([
      expect.objectContaining({
        evento: "Mogi das Cruzes vs Bauru",
        mercado: "Moneyline",
        selecao: "Mogi HT FT",
      }),
      expect.objectContaining({
        evento: "Bayamon vs Aguadas",
        mercado: "Moneyline",
        selecao: "Bayamon",
      }),
    ]);
    expect(ticket && isMultiFixtureTicket(ticket)).toBe(true);
  });

  it("separa combo do mesmo jogo (ML + total)", () => {
    const ticket = parseBetLegs(
      "Mogi das cruzes x Bauru",
      "Mogi ML H5 FT + Mogi O89,5",
    );
    expect(ticket?.kind).toBe("same_game");
    expect(ticket?.legs).toHaveLength(2);
    expect(ticket?.legs[0]).toEqual(expect.objectContaining({
      evento: "Mogi das cruzes vs Bauru",
      mercado: "Moneyline",
    }));
    expect(ticket?.legs[1]?.mercado).toMatch(/Total/);
    expect(ticket && isMultiFixtureTicket(ticket)).toBe(false);
  });

  it("separa dupla gravada com pipe no evento", () => {
    const ticket = parseBetLegs(
      "France vs Morocco | Spain vs Italy",
      "France / Spain",
    );
    expect(ticket?.kind).toBe("parlay");
    expect(ticket?.legs).toEqual([
      expect.objectContaining({
        evento: "France vs Morocco",
        mercado: "Moneyline",
        selecao: "France",
      }),
      expect.objectContaining({
        evento: "Spain vs Italy",
        mercado: "Moneyline",
        selecao: "Spain",
      }),
    ]);
    expect(ticket && isMultiFixtureTicket(ticket)).toBe(true);
  });

  it("não trata evento de dois jogos como same_game", () => {
    expect(parseBetLegs(
      "France vs Morocco | Spain vs Italy",
      "France / Spain / Italy",
    )).toBeNull();
    const ticket = parseBetLegs(
      "France vs Morocco | Spain vs Italy",
      "France + Over 1.5",
    );
    expect(ticket?.kind).toBe("parlay");
    expect(ticket && isMultiFixtureTicket(ticket)).toBe(true);
  });

  it("não parte confronto único escrito com barra", () => {
    expect(parseBetLegs("Flamengo / Palmeiras", "Flamengo")).toBeNull();
    expect(parseBetLegs("Santos x Grêmio", "Santos +0.5")).toBeNull();
    expect(parseBetLegs("Staking Nicolas / SL", "Se voltar -1 @1.6")).toBeNull();
  });
});

describe("parseBetLegs — o período do mercado do bilhete", () => {
  const periodos = (mercado: string, selecao = "Over 0.5 + Flamengo") =>
    parseBetLegs("Flamengo x Palmeiras", selecao, mercado)?.legs.map((leg) => marketPeriodOf(leg.mercado));

  it("'1º Tempo' leva o período às pernas que não declaram o próprio", () => {
    expect(periodos("1º Tempo")).toEqual(["HT", "HT"]);
    expect(periodos("Total – 1st Half")).toEqual(["HT", "HT"]);
    expect(periodos("1º Tempo - Criar Aposta", "Flamengo -0.5 + Over 1.5")).toEqual(["HT", "HT"]);
  });

  it("2º tempo sem variante no catálogo fica com o rótulo do bilhete, que não liquida como jogo inteiro", () => {
    expect(periodos("2º Tempo")).toEqual(["SECOND_HALF", "SECOND_HALF"]);
  });

  it("sem período no mercado, ou com período próprio na perna, nada muda", () => {
    expect(periodos("Criar Aposta")).toEqual(["FT", "FT"]);
    expect(parseBetLegs("Flamengo x Palmeiras", "Over 0.5 2T + Flamengo", "1º Tempo")?.legs[0])
      .toMatchObject({ mercado: "Total", selecao: "Over 0.5 2T" });
  });
});

describe("foldLegStatuses", () => {
  it("qualquer perna perdida perde o ticket; todas ganhas ganham", () => {
    expect(foldLegStatuses([BetStatus.WON, BetStatus.LOST])).toEqual({
      ok: true,
      status: BetStatus.LOST,
    });
    expect(foldLegStatuses([BetStatus.WON, BetStatus.WON])).toEqual({
      ok: true,
      status: BetStatus.WON,
    });
    expect(foldLegStatuses([BetStatus.WON, BetStatus.VOID]).ok).toBe(false);
  });
});


it("prorrogação declarada no bilhete textual chega a cada perna", () => {
  const ticket = parseBetLegs("France vs Morocco | Spain vs Italy", "France / Spain", "Vencedor incluindo prorrogação");
  expect(ticket?.legs).toHaveLength(2);
  expect(ticket?.legs.every((leg) => marketIncludesExtraTime(leg.mercado))).toBe(true);
});
