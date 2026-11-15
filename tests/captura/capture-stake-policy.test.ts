import { describe, expect, it } from "vitest";
import { historicalStakeSettings, preserveCaptureStakeSnapshot } from "@/src/domain/capture-financial-history";
import { resolveCaptureStake, validateCaptureStakeSettings } from "@/src/domain/capture-stake-policy";
import { mapLlmBetToParsedList } from "@/src/services/capture/reading/extraction-mapping";
import { parseUniversalBetPost } from "@/src/domain/parse-bet-post";
import { preparePlayerCaptureBatch } from "@/src/domain/player-prop-capture";
import { finalizeParsedBetForCapture } from "@/src/services/capture/preparation/parse-capture-guard";

const now = new Date("2026-09-09T00:19:00Z");
const raw = { isBet: true, evento: "Zaqatala vs Baku Sporting FC", mercado: "Asian Handicap", selecao: "Baku Sporting FC +0", odds: 2, dataTexto: "10/09", casaDeAposta: "bet365" };
const fallback = { stakePolicy: "WHEN_MISSING" as const, defaultStakeUnits: 1 };
const fixed = { stakePolicy: "ALWAYS" as const, defaultStakeUnits: 0.75 };

describe("stake configurada por banca", () => {
  it("mantém sem registro a stake ausente quando a banca não optou por padrão", () => {
    expect(mapLlmBetToParsedList(raw, now)).toBeNull();
    expect(mapLlmBetToParsedList(raw, now, { stakePolicy: "MESSAGE" })).toBeNull();
  });
  it("completa a aposta do Baku com 1u sem trocar a odd da imagem ou o handicap", () => {
    const bets = mapLlmBetToParsedList(raw, now, fallback);
    expect(bets).toHaveLength(1);
    expect(bets?.[0]).toMatchObject({ stake: 1, odds: 2, selecao: "Baku Sporting FC +0", stakePolicySnapshot: { source: "bankroll_default", originalStake: null, defaultStakeUnits: 1 } });
  });
  it("quando ausente respeita stake explícita e não mascara número inválido", () => {
    expect(mapLlmBetToParsedList({ ...raw, stake: 2 }, now, fallback)?.[0]?.stake).toBe(2);
    expect(mapLlmBetToParsedList({ ...raw, stake: -2 }, now, fallback)).toBeNull();
    expect(mapLlmBetToParsedList({ ...raw, odds: 0 }, now, fallback)).toBeNull();
    expect(mapLlmBetToParsedList({ ...raw, isBet: false }, now, fallback)).toBeNull();
  });
  it("stake fixa resiste à legenda e mantém a política de odd independente", () => {
    const bet = mapLlmBetToParsedList({ ...raw, stake: 3 }, now, fixed)?.[0];
    expect(bet).toBeTruthy();
    const result = finalizeParsedBetForCapture(bet!, "3u @1.90", "IMAGE_ODD");
    expect(result).toMatchObject({ ok: true, bet: { stake: 0.75, odds: 2, stakePolicySnapshot: { source: "bankroll_fixed", originalStake: 3 } } });
    expect(finalizeParsedBetForCapture(bet!, "3u @1.90", "CAPTION_ODD")).toMatchObject({ ok: true, bet: { stake: 0.75, odds: 1.9 } });
  });
  it("aplica a mesma decisão no parser de texto", () => {
    const text = "Evento: Zaqatala vs Baku Sporting FC\nMercado: Asian Handicap\nEntrada: Baku Sporting FC +0\nOdd: 2.0\nData: 10/09";
    expect(parseUniversalBetPost(text, { now })).toMatchObject({ ok: false, missing: ["stake"] });
    expect(parseUniversalBetPost(text, { now, stakeSettings: fallback })).toMatchObject({ ok: true, bet: { stake: 1 } });
    expect(parseUniversalBetPost(`${text}\nStake: 0u`, { now, stakeSettings: fallback })).toMatchObject({ ok: false, missing: ["stake"] });
    for (const invalid of ["-2u", "Stake: abc", "Stake: 1.2.3u", "Stake: 2000u"]) {
      expect(parseUniversalBetPost(`${text}\n${invalid}`, { now, stakeSettings: fallback })).toMatchObject({ ok: false, missing: ["stake"] });
    }
    expect(parseUniversalBetPost(`${text}\nStake: 3u`, { now, stakeSettings: fixed })).toMatchObject({ ok: true, bet: { stake: 0.75, stakePolicySnapshot: { originalStake: 3 } } });
  });
  it("banca WHEN_MISSING não aplica o padrão quando o post escreveu a stake", () => {
    const text = "Flamengo x Palmeiras\nOver 2.5 @1.90";
    expect(parseUniversalBetPost(`${text}\nStake 2`, { now, stakeSettings: fallback }))
      .toMatchObject({ ok: true, bet: { stake: 2, stakePolicySnapshot: { source: "message", originalStake: 2 } } });
    for (const written of ["2%", "2% da banca", "Stake 3/10", "💰 Stake: 3/10", "💰 1.5"]) {
      expect(parseUniversalBetPost(`${text}\n${written}`, { now, stakeSettings: fallback })).toMatchObject({ ok: false, missing: ["stake"] });
    }
    expect(parseUniversalBetPost(text, { now, stakeSettings: fallback }))
      .toMatchObject({ ok: true, bet: { stake: 1, stakePolicySnapshot: { source: "bankroll_default" } } });
  });
  it.each(["21.30", "90", "🔥 85%", "⭐ 3", "⭐️ 4.5", "🌟 2%"])("banca WHEN_MISSING: número solto que não é stake ('%s') não impede o padrão", (line) => {
    expect(parseUniversalBetPost(`Flamengo x Palmeiras\nOver 2.5 @1.90\n${line}`, { now, stakeSettings: fallback }))
      .toMatchObject({ ok: true, bet: { stake: 1, stakePolicySnapshot: { source: "bankroll_default" } } });
  });
  it("mantém uma stake por simples de jogador com regra fixa ou ausente", () => {
    const items = [{ ...raw, mercado: "Player Shots", selecao: "Ganso Over 0.5", stake: 2 }, { ...raw, mercado: "Player Shots", selecao: "Ganso Over 1.5", stake: 0.5 }];
    const bets = mapLlmBetToParsedList({ isBet: true, items }, now, fixed)!;
    const batch = preparePlayerCaptureBatch(bets, "2u\n0.5u", true);
    expect(batch).toMatchObject({ ok: true, bets: [{ stake: 0.75 }, { stake: 0.75 }] });
    const missing = mapLlmBetToParsedList({ isBet: true, items: items.map(({ stake: _, ...item }) => item) }, now, fallback)!;
    expect(preparePlayerCaptureBatch(missing, "", false)).toMatchObject({ ok: true, bets: [{ stake: 1, stakePolicySnapshot: { source: "bankroll_default" } }, { stake: 1 }] });
  });
  it("guarda a política usada na entrada para editar sem usar a configuração nova", () => {
    const snapshot = resolveCaptureStake(2, fixed).snapshot;
    const captureStakeSnapshot = preserveCaptureStakeSnapshot({ stakePolicySnapshot: snapshot });
    expect(resolveCaptureStake(3, historicalStakeSettings({ captureStakeSnapshot })).stake).toBe(0.75);
    expect(historicalStakeSettings({ captureStakeSnapshot: preserveCaptureStakeSnapshot({}) })).toBeUndefined();
  });
  it.each([0, -1, 100.01, Infinity, NaN, 0.0000001])("rejeita stake configurada inválida: %s", (defaultStakeUnits) => {
    expect(() => validateCaptureStakeSettings({ stakePolicy: "ALWAYS", defaultStakeUnits })).toThrow();
  });
  it("rejeita modo ativo sem valor e aceita desativar a política", () => {
    expect(() => validateCaptureStakeSettings({ stakePolicy: "WHEN_MISSING" })).toThrow();
    expect(validateCaptureStakeSettings({ stakePolicy: "MESSAGE", defaultStakeUnits: null })).toEqual({ stakePolicy: "MESSAGE", defaultStakeUnits: null });
  });
});
