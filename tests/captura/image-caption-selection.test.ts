import { describe, expect, it } from "vitest";
import type { ParsedBetPost } from "@/src/domain/bet-capture";
import { reconcileImageCaptionSelection } from "@/src/domain/image-caption-selection";
import { pinnacleizeSelecao } from "@/src/domain/mercados/selecao";

const caption = "Araujo / SL\n\nPinheiros +70.5 Pontos @1.80\n\n1u / Até +71.5 Pontos\nhttps://www.bet365.bet.br/#/IP/EV152008788195C18";
function bet(selecao: string, odds = 1.8, mercado = "Team Total (Points)"): ParsedBetPost {
  return { evento: "Corinthians vs Pinheiros", esporte: "Basketball", pais: "", competicao: "", mercado, selecao, odds, stake: 1, stakeSource: "caption", data: null, casaDeAposta: "bet365" };
}
const grid = [bet("Corinthians Mais de 83.5", 1.83), bet("Corinthians Menos de 83.5", 1.83), bet("Pinheiros Mais de 70.5"), bet("Pinheiros Menos de 70.5", 1.86)];

describe("seleção da legenda sobre uma grade de mercados", () => {
  it("padroniza +70.5 no total do time sem alterar handicaps ou apagar qualificadores", () => {
    const params = { selecao: "Pinheiros +70.5 Pontos", evento: "Corinthians vs Pinheiros", mercadoPinnacle: "Team Total (Points)" };
    expect(pinnacleizeSelecao(params)).toBe("Pinheiros Over 70.5");
    expect(pinnacleizeSelecao({ ...params, selecao: "Pinheiros +70,5 Pontos" })).toBe("Pinheiros Over 70.5");
    expect(pinnacleizeSelecao({ ...params, mercadoPinnacle: "Handicap (Points)" })).toBe("Pinheiros +70.5");
    expect(pinnacleizeSelecao({ ...params, selecao: "Pinheiros +70.5 Pontos 1st Half" })).toBe("Pinheiros +70.5 Pontos 1st Half");
    expect(pinnacleizeSelecao({ ...params, selecao: "Pinheiros +70.5 Corners" })).toBe("Pinheiros +70.5 Corners");
  });
  it("seleciona somente Pinheiros Over 70.5 e preserva os termos da seleção", () => {
    expect(reconcileImageCaptionSelection(grid, caption)).toEqual({ ok: true, bets: [grid[2]] });
  });
  it.each(["Pinheiros Mais de 71.5", "Pinheiros Menos de 70.5", "Corinthians Mais de 70.5"])("rejeita leitura divergente: %s", (selection) => {
    expect(reconcileImageCaptionSelection([bet(selection)], caption)).toMatchObject({ ok: false, reason: "selecao_diverge_legenda" });
  });
  it("não elege uma opção pela odd nem replica uma stake sobre opções", () => {
    expect(reconcileImageCaptionSelection([grid[0]!, grid[1]!, grid[3]!], caption)).toMatchObject({ ok: false });
  });
  it("recusa ambiguidade entre períodos e entre eventos diferentes", () => {
    expect(reconcileImageCaptionSelection([grid[2]!, { ...grid[2]!, mercado: "Team Total (Points) – 1st Half" }], caption)).toMatchObject({ ok: false });
    expect(reconcileImageCaptionSelection([grid[2]!, { ...grid[2]!, evento: "Franca vs Pinheiros" }], caption)).toMatchObject({ ok: false });
  });
  it("reconhece nome canônico, vírgula decimal e seleção sem @", () => {
    const canonical = { ...bet("EC Pinheiros SP Over 70.5"), evento: "Corinthians Paulista vs EC Pinheiros SP" };
    expect(reconcileImageCaptionSelection([canonical], "Pinheiros mais de 70,5 pontos\n1u")).toEqual({ ok: true, bets: [canonical] });
  });
  it("o horário antes da linha não leva o sinal dela", () => {
    const totals = [bet("Over 2.5", 1.9, "Total – Match"), bet("Under 2.5", 1.9, "Total – Match")];
    expect(reconcileImageCaptionSelection(totals, "(21:00) -2.5\n@1.90 1u")).toEqual({ ok: true, bets: [totals[1]] });
  });
  it("não confunde a stake após um traço com uma segunda seleção", () => {
    expect(reconcileImageCaptionSelection(grid, "Pinheiros +70.5 Pontos - 1u @1.80")).toEqual({ ok: true, bets: [grid[2]] });
  });
  it("respeita a direção Under e a estatística explicitada", () => {
    expect(reconcileImageCaptionSelection(grid, "Pinheiros Under 70.5 Pontos @1.86\n1u")).toEqual({ ok: true, bets: [grid[3]] });
    expect(reconcileImageCaptionSelection([bet("Pinheiros Over 70.5", 1.8, "Team Total (Corners)")], caption)).toMatchObject({ ok: false });
  });
  it("não transforma total do time em total do jogo", () => {
    expect(reconcileImageCaptionSelection([bet("Over 70.5", 1.8, "Total (Points)")], caption)).toMatchObject({ ok: false });
  });
  it("preserva o sinal quando a imagem mostra handicap", () => {
    const spread = bet("Pinheiros +7.5", 1.8, "Handicap (Points)");
    expect(reconcileImageCaptionSelection([spread, { ...spread, selecao: "Pinheiros -7.5" }], "Pinheiros +7.5 @1.80\n1u")).toEqual({ ok: true, bets: [spread] });
  });
  it("aceita a unidade implícita de placar nos mercados canônicos", () => {
    const football = { ...bet("Pinheiros Over 1.5", 1.8, "Team Total – Match"), esporte: "Soccer" };
    expect(reconcileImageCaptionSelection([football], "Pinheiros +1.5 gols @1.80\n1u")).toEqual({ ok: true, bets: [football] });
    const basketball = bet("Pinheiros Over 70.5", 1.8, "Team Total");
    expect(reconcileImageCaptionSelection([basketball], caption)).toEqual({ ok: true, bets: [basketball] });
  });
  it("o horário do jogo na frente da linha da legenda não vira o sujeito dela", () => {
    const total = { ...bet("Over 2.5", 1.9, "Total – Match"), evento: "Flamengo vs Palmeiras", esporte: "Soccer" };
    expect(reconcileImageCaptionSelection([total], "(21:00) Over 2.5 @1.90\n1u")).toEqual({ ok: true, bets: [total] });
  });
  it("o horário depois da linha sai sem levar o sinal que dá a direção", () => {
    const over = { ...bet("Over 2.5", 1.9, "Total – Match"), evento: "Flamengo vs Palmeiras", esporte: "Soccer" };
    const under = { ...over, selecao: "Under 2.5" };
    expect(reconcileImageCaptionSelection([over, under], "-2.5 (21:00)\n@1.90 1u")).toEqual({ ok: true, bets: [under] });
  });
  it("mantém várias simples quando a legenda só informa as stakes", () => {
    const singles = [bet("York -1.0", 1.95, "Handicap (Corners)"), bet("Barnet +1.5", 1.9, "Handicap (Corners)")];
    expect(reconcileImageCaptionSelection(singles, "0.25u em cada simples")).toEqual({ ok: true, bets: singles });
  });
  it("mantém três simples de Ganso, incluindo mercados distintos", () => {
    const singles = [bet("Ganso Over 0.5", 3.8, "Player Shots on Target"), { ...bet("Ganso Over 0.5", 1.89, "Player Shots"), stake: 2 }, { ...bet("Ganso Over 1.5", 5.1, "Player Shots"), stake: 0.5 }];
    expect(reconcileImageCaptionSelection(singles, "")).toEqual({ ok: true, bets: singles });
    expect(reconcileImageCaptionSelection(singles, "1u\n2u\n0.5u")).toEqual({ ok: true, bets: singles });
  });
  it("não descarta outras escolhas explícitas da legenda", () => {
    const picks = [grid[0]!, grid[2]!];
    expect(reconcileImageCaptionSelection(picks, "Corinthians Over 83.5 @1.83\nPinheiros Over 70.5 @1.80\n1u cada")).toEqual({ ok: true, bets: picks });
  });
});
