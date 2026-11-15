import { describe, expect, it } from "vitest";
import { canonicalizeBetForRegistration } from "@/src/services/bets/canonicalize-registration";
import { canonicalSport } from "@/src/domain/sports/registry";
import { detectSportFromText } from "@/src/domain/sports/detect";
import { flashscoreSportId } from "@/src/providers/flashscore/sports";
import { pinnacle17SportId } from "@/src/providers/pinnacle17/types";
import { matchTeamSide } from "@/src/domain/settlement/sides";

describe("captura: preservar termos antes de buscar sharp", () => {
  const base = { evento: "Alpha vs Beta", esporte: "Soccer", pais: "Chile", competicao: "Primera B" };
  it.each([
    ["1st Half Draw No Bet", "Alpha"], ["Draw No Bet", "Alpha 1st Half"],
    ["Draw No Bet Corners", "Alpha"], ["Draw No Bet", "Alpha +1 DNB"],
    ["Draw No Bet", "Draw"], ["Total", "Alpha DNB"], ["Outright Winner", "Alpha DNB"],
  ])("não transforma %s/%s em handicap FT", async (mercado, selecao) => {
    const bet = await canonicalizeBetForRegistration({ ...base, mercado, selecao });
    expect(bet.mercado).toBe(mercado);
    expect(bet.selecao).toBe(selecao);
  });
  it.each(["Alpha DNB", "Alpha", "Home"])("DNB válido continua equivalente: %s", async selecao => {
    expect(await canonicalizeBetForRegistration({ ...base, mercado: "Draw No Bet", selecao }))
      .toMatchObject({ mercado: "Handicap – Match", selecao: "Alpha 0" });
  });
  it.each([18, 19, 20, 21, 23, 24])("Under %s como linha não vira categoria juvenil", line => {
    expect(matchTeamSide(`Ben Shelton Under ${line}`, "Ben Shelton vs Carlos Alcaraz")).toBe("home");
    expect(matchTeamSide(`England U21 Under ${line}`, "England vs Germany")).toBeNull();
  });
  it("distingue Rugby League de Rugby Union desde o registro", () => {
    expect(canonicalSport("Rugby League")).toBe("Rugby League");
    expect(canonicalSport("Rugby Union")).toBe("Rugby");
    expect(pinnacle17SportId(canonicalSport("Rugby League")!)).toBe(26);
    expect(flashscoreSportId(canonicalSport("Rugby League")!)).toBe(19);
    expect(flashscoreSportId(canonicalSport("Rugby Union")!)).toBe(8);
  });
  it.each(["Badminton", "Water Polo", "Aussie Rules", "Cycling", "Formula 1", "Rugby League"])("permite registrar modalidade mapeada: %s", sport => {
    expect(canonicalSport(sport)).toBe(sport);
    expect(pinnacle17SportId(sport)).not.toBeNull();
    expect(detectSportFromText(sport).sport).toBe(sport);
  });
  it.each([["Water Polo Champions League", "Water Polo"], ["Polo Aquático Champions League", "Water Polo"],
    ["Futebol Australiano - AFL", "Aussie Rules"], ["Australian Rules Football", "Aussie Rules"], ["🏉 Rugby League - NRL", "Rugby League"]])("variante explícita não vira futebol ou Union: %s", (text, sport) => {
    expect(detectSportFromText(text)).toMatchObject({ status: "CONFIRMED", sport });
  });
});
