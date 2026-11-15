import { describe, expect, it } from "vitest";
import {
  hasEmptyStakeOrOddLabel,
  isIncompleteNumericDraft,
  isPhotoCaptionIncompleteDraft,
  missingOnlyNumericFields,
} from "@/src/services/capture/reading/incomplete-draft";
import { parseUniversalBetPost } from "@/src/domain/parse-bet-post";

const NOW = new Date("2026-06-15T19:00:00Z");

describe("rascunho de canal sem stake/odd", () => {
  it("reconhece rótulo vazio e Stake: u", () => {
    expect(hasEmptyStakeOrOddLabel("Stake:")).toBe(true);
    expect(hasEmptyStakeOrOddLabel("Stake:   ")).toBe(true);
    expect(hasEmptyStakeOrOddLabel("Stake: u")).toBe(true);
    expect(hasEmptyStakeOrOddLabel("ODD:")).toBe(true);
    expect(hasEmptyStakeOrOddLabel("Stake: 1u")).toBe(false);
  });

  it.each(["Min @1.70", "Odd mín: 1.70", "Odd mínima 1,70"])("odd mínima como único preço (%s) não é rascunho: a odd não chega na edição", (floor) => {
    const text = ["⚽ Coquimbo Unido vs Colo Colo", "Entrada: Casa", floor, "Stake: 1u"].join("\n");
    const parsed = parseUniversalBetPost(text, { now: NOW });
    expect(parsed).toEqual({ ok: false, missing: ["odds"] });
    expect(isIncompleteNumericDraft(text, ["odds"])).toBe(false);
    expect(isIncompleteNumericDraft(text.replace(floor, "ODD:"), ["odds"])).toBe(true);
  });

  it("só stake ausente é rascunho, mercado ausente não", () => {
    const rawText = [
      "⚽ Coquimbo Unido vs Colo Colo",
      "Entrada: Casa",
      "ODD: 2.10",
      "Stake:",
    ].join("\n");
    const draft = parseUniversalBetPost(rawText, { now: NOW });
    expect(draft.ok).toBe(false);
    if (draft.ok) return;
    expect(draft.missing).toEqual(["stake"]);
    expect(isIncompleteNumericDraft(rawText, draft.missing)).toBe(true);

    const mercado = parseUniversalBetPost(
      ["🎾 Sinner vs Fritz", "Entrada: +22.5", "@1.90", "1u"].join("\n"),
      { now: NOW },
    );
    expect(mercado).toEqual({ ok: false, missing: ["mercado"] });
    expect(isIncompleteNumericDraft("🎾 Sinner vs Fritz", ["mercado"])).toBe(false);
    expect(missingOnlyNumericFields(["mercado"])).toBe(false);
  });

  it("odd nua que o universal não lê não é rascunho: a cascata a lê", () => {
    const text = "Flamengo x Palmeiras\nAmbas marcam 1.85\n1u";
    const parsed = parseUniversalBetPost(text, { now: NOW });
    expect(parsed).toEqual({ ok: false, missing: ["odds"] });
    expect(isIncompleteNumericDraft(text, ["odds"])).toBe(false);
    // Sem número nenhum continua rascunho: o tipster completa no edit.
    expect(isIncompleteNumericDraft("Flamengo x Palmeiras\nAmbas marcam\n1u", ["odds"])).toBe(true);
    // Stake ausente com a odd lida continua rascunho.
    expect(isIncompleteNumericDraft("Flamengo x Palmeiras\nAmbas marcam 1.85", ["stake"])).toBe(true);
  });

  it.each([
    "Flamengo x Palmeiras\nOver 2.5 (1.90)\n1u",
    "🔴 AO VIVO\nFlamengo x Palmeiras\nAmbas marcam 1.85\n1u",
    "🟢 ENTRADA CONFIRMADA\nFlamengo x Palmeiras\nAmbas marcam 1.85\n1u",
    "Flamengo x Palmeiras\nAmbas marcam 1.85\n1u\n✅ Planilha: bit.ly/planilha",
  ])("odd escrita que o universal não lê não é rascunho: %j", (text) => {
    expect(parseUniversalBetPost(text, { now: NOW })).toEqual({ ok: false, missing: ["odds"] });
    expect(isIncompleteNumericDraft(text, ["odds"])).toBe(false);
  });

  it("legenda informativa com odd mas sem rótulo de stake vazio não é rascunho", () => {
    const caption = [
      "Big Data Bet Métodos (asian away)",
      "",
      "25/08 - Inglaterra - odd 1,77",
      "https://www.bet365.bet.br/#/AC/B1/C1/D8/E200057053/F3/I3/",
    ].join("\n");

    expect(isPhotoCaptionIncompleteDraft(caption, ["stake"])).toBe(false);
    expect(isPhotoCaptionIncompleteDraft(caption, ["odds"])).toBe(false);
    expect(hasEmptyStakeOrOddLabel(caption)).toBe(false);
  });
});

describe("stake escrita num formato que a regra não lê", () => {
  it.each(["Stake: 3/10", "Stake: 2 de 5"])("'%s' vai para a IA em vez de ficar preso como rascunho", (stakeLine) => {
    const text = `Jogo: Flamengo x Palmeiras\nEntrada: Flamengo ML\nOdd: 1.90\n${stakeLine}`;
    const parsed = parseUniversalBetPost(text, { now: NOW });
    expect(parsed).toEqual({ ok: false, missing: ["stake"] });
    expect(isIncompleteNumericDraft(text, ["stake"])).toBe(false);
  });

  it("'Stake: 2%' é lida como 2u pela regra (1% = 1u)", () => {
    expect(parseUniversalBetPost("Jogo: Flamengo x Palmeiras\nEntrada: Flamengo ML\nOdd: 1.90\nStake: 2%", { now: NOW }))
      .toMatchObject({ ok: true, bet: { stake: 2 } });
  });

  it.each([
    ["Stake 3/10"],
    ["💰 Stake: 3/10"],
    ["2%"],
    ["2% da banca"],
    ["💰 2% da banca"],
    ["💰 1.5"],
  ])("'%s' sem os dois-pontos ou com ornamento também vai para a IA", (stakeLine) => {
    const text = `Flamengo x Palmeiras\nOver 2.5 @1.90\n${stakeLine}`;
    expect(parseUniversalBetPost(text, { now: NOW })).toEqual({ ok: false, missing: ["stake"] });
    expect(isIncompleteNumericDraft(text, ["stake"])).toBe(false);
  });

  it("basta um número que falta estar escrito para o post ir à IA", () => {
    const text = "Flamengo x Palmeiras\nOver 2.5\nStake 3/10";
    expect(isIncompleteNumericDraft(text, ["odds", "stake"])).toBe(false);
    expect(isIncompleteNumericDraft(`${text}\n@1.90`, ["stake"])).toBe(false);
    expect(isIncompleteNumericDraft("Flamengo x Palmeiras\nOver 2.5\nStake:", ["odds", "stake"])).toBe(true);
  });

  it.each([
    "Flamengo x Palmeiras\nAmbas marcam 1.85\n💰 2",
    "Flamengo x Palmeiras\nAmbas marcam 1.85\n💰 1.5",
    "Flamengo x Palmeiras\nAmbas marcam 1.85\n1.5",
  ])("odd sem '@' seguida da stake, que a regra não vê: %j vai à IA", (text) => {
    expect(parseUniversalBetPost(text, { now: NOW })).toEqual({ ok: false, missing: ["odds", "stake"] });
    expect(isIncompleteNumericDraft(text, ["odds", "stake"])).toBe(false);
  });

  it("rótulo vazio continua sendo rascunho", () => {
    expect(isIncompleteNumericDraft("Jogo: Flamengo x Palmeiras\nEntrada: Flamengo ML\nOdd: 1.90\nStake:", ["stake"])).toBe(true);
  });
});
