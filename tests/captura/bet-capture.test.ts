import { describe, expect, it } from "vitest";
import { z } from "zod";
import { capturedTermsSchema, captureParsedSchema, correctedReadingFields } from "@/src/domain/bet-capture";

describe("correctedReadingFields", () => {
  const read = { evento: "Flamengo vs Palmeiras", mercado: "Asian Handicap", selecao: "Flamengo +0.25", odds: 1.9, stake: 1 };

  it("a mesma linha escrita de outro jeito não é correção", () => {
    expect(correctedReadingFields(read, { ...read, selecao: "Flamengo 0/+0.5" })).toEqual([]);
    expect(correctedReadingFields({ ...read, mercado: "Total", selecao: "Over 2.25" }, { ...read, mercado: "Total", selecao: "Over 2,2.5" })).toEqual([]);
  });

  it("dígito no nome do time não é linha", () => {
    const vointa = { ...read, evento: "Vointa 2024 vs Rapid", selecao: "Vointa 2024 -0.5" };
    expect(correctedReadingFields(vointa, { ...vointa, selecao: "VOINTA 2024 -0.5" })).toEqual([]);
    expect(correctedReadingFields({ ...vointa, selecao: "Vointa 2024 +0.25" }, { ...vointa, selecao: "Vointa 2024 0/+0.5" })).toEqual([]);
    expect(correctedReadingFields(vointa, { ...vointa, selecao: "Vointa 2024 -1" })).toEqual(["linha"]);
  });

  it("separa linha, seleção, odd e stake", () => {
    expect(correctedReadingFields(read, { ...read, selecao: "Palmeiras +0.25", odds: 1.95, stake: 2 })).toEqual(["selecao", "odds", "stake"]);
    expect(correctedReadingFields(read, { ...read, selecao: "Flamengo -0.25" })).toEqual(["linha"]);
  });
});

describe("captureParsedSchema", () => {
  /** A evidência que a captura do canal grava de um post lido pela regra. */
  const written = {
    evento: "Flamengo vs Palmeiras", esporte: "Soccer", competicao: "", pais: "", mercado: "Resultado Final", selecao: "Casa",
    liveScoreHome: null, liveScoreAway: null, odds: 2.1, stake: 1, data: "2026-06-15T19:00:00.000Z", kickoffDateOnly: false,
    casaDeAposta: "", sportResolution: {
      sport: "Soccer", status: "CONFIRMED", confidence: 95, source: "EMOJI",
      evidence: [{ source: "EMOJI", sport: "Soccer", confidence: 95, value: "⚽" }], resolverVersion: 14,
    },
    stakePolicySnapshot: { version: 1, stakePolicy: "MESSAGE", source: "message", defaultStakeUnits: null, originalStake: 1 },
  };
  const onContract = (parsed: unknown) => z.strictObject(captureParsedSchema.shape).safeParse(parsed).success;

  it("aceita o que cada caminho grava: post, item de lote, captura pedida pelo dono e DM", () => {
    expect(onContract(written)).toBe(true);
    expect(onContract({ ...written, stakeSource: "caption", mediaFileIds: ["file-1", "file-2"], liveScoreEvidence: "(1-0)" })).toBe(true);
    expect(onContract({ ...written, forcedByOperator: true })).toBe(true);
    const { stakePolicySnapshot: _snapshot, ...dm } = written;
    expect(onContract({ ...dm, data: null, sportResolution: { ...written.sportResolution, sport: null, status: "PENDING", evidence: [] } })).toBe(true);
  });

  it("recusa o que o painel ou a reentrega do lote leriam errado", () => {
    // O painel lê `parsedJson->>'forcedByOperator'` em SQL: só o booleano true no topo marca o pedido do dono.
    expect(onContract({ ...written, forcedByOperator: "true" })).toBe(false);
    expect(onContract({ ...written, forcedByOperator: false })).toBe(false);
    expect(onContract({ ...written, liveScoreHome: "1" })).toBe(false);
    expect(onContract({ ...written, data: "15/06 16:00" })).toBe(false);
    const { sportResolution: _sport, ...withoutSport } = written;
    expect(onContract(withoutSport)).toBe(false);
    expect(onContract({ ...written, campoNovo: 1 })).toBe(false);
  });

  it("os termos lidos bastam para comparar a edição com a captura", () => {
    expect(capturedTermsSchema.safeParse({ evento: "A vs B", mercado: "Total", selecao: "Over 2.5", odds: 1.9, stake: 1 }).success).toBe(true);
    expect(capturedTermsSchema.safeParse({ evento: "", mercado: "Total", selecao: "Over 2.5", odds: 1.9, stake: 1 }).success).toBe(false);
  });
});
