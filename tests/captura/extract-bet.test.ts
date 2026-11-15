import { beforeEach, describe, expect, it, vi } from "vitest";
import playerSlips from "../fixtures/player-props/hojlund-two-singles.json";
import { entrouAoVivo } from "@/src/domain/entrada-ao-vivo";
import { canonicalizeAsianHandicapSelecao } from "@/src/domain/asian-handicap-line";
import type { CapturePolicy } from "@/src/domain/capture-policy";
import { pinnacleizeMercado } from "@/src/domain/mercados/finalize";
import { pinnacleizeSelecao } from "@/src/domain/mercados/selecao";
import { buildPlayerPropTerms } from "@/src/domain/settlement/player-prop-terms";
import type { LlmCascadeOutcome, LlmGenerateJsonParams } from "@/src/infra/llm/cascade";
import { finalizeParsedBetForCapture } from "@/src/services/capture/preparation/parse-capture-guard";

const mocks = vi.hoisted(() => ({
  generate: vi.fn<(params: LlmGenerateJsonParams) => Promise<unknown>>(),
  /** Como a cascata terminou quando `generate` devolve null. */
  exhaustion: { kind: "unavailable", responded: false } as Exclude<LlmCascadeOutcome, { kind: "accepted" }>,
  profile: vi.fn<(base64: string) => Promise<"compact-bet365-slip-v1" | undefined>>(),
}));
vi.mock("@/src/infra/llm/cascade", () => ({
  llmAvailable: async () => true,
  llmGenerateJsonOutcome: async (params: LlmGenerateJsonParams) => {
    const result = await mocks.generate(params);
    return result ? { kind: "accepted", ...result } : mocks.exhaustion;
  },
}));
vi.mock(import("@/src/services/capture/reading/ocr-extraction-contract"), async (importOriginal) => ({
  ...await importOriginal(),
  mistralImageProfile: mocks.profile,
}));

const { extractBetFromImage, extractBetFromText, extractBetsFromImages, extractPlayerBetsFromImage } = await import("@/src/services/capture/reading/extract-bet");
const { llmBetSchema, RESPONSE_SCHEMA } = await import("@/src/services/capture/reading/extraction-contract");
const { mapLlmBetToParsed, mapLlmBetToParsedList } = await import("@/src/services/capture/reading/extraction-mapping");
const { extractionContentProblem } = await import("@/src/services/capture/reading/extraction-quality");

beforeEach(() => {
  mocks.generate.mockReset();
  mocks.exhaustion = { kind: "unavailable", responded: false };
  mocks.profile.mockReset().mockResolvedValue(undefined);
});

describe("completude entre leitores", () => {
  const now = new Date("2026-09-12T12:00:00Z");
  const raw = { isBet: true, evento: "Alpha vs Beta", mercado: "Asian Handicap", selecao: "Alpha +0.25", odds: 1.9, stake: 1 };
  const image = { base64: "fixture", mimeType: "image/jpeg" };

  it("continua de uma leitura sem odd para uma leitura completa", async () => {
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
      expect(params.accept?.({ ...raw, odds: null })).toBe(false);
      expect(params.accept?.(raw)).toBe(true);
      return { provider: "groq", data: raw };
    });
    expect(await extractBetFromImage(image, "1u", now)).toMatchObject({ provider: "groq", bet: { odds: 1.9, stake: 1 } });
  });
  it("uma recusa visual não impede outro leitor de identificar o bilhete", async () => {
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
      expect(params.accept?.({ isBet: false, items: [] })).toBe(false);
      expect(params.accept?.(raw)).toBe(true);
      return { provider: "groq", data: raw };
    });
    expect(await extractBetFromImage(image, "1u", now)).toMatchObject({ provider: "groq", bet: { odds: 1.9 } });
  });
  it("preserva o rascunho mais completo sem mesclar números entre leitores ou aceitar não-aposta posterior", async () => {
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
      expect(params.accept?.({ ...raw, odds: null, stake: null })).toBe(false);
      expect(params.accept?.({ ...raw, odds: null })).toBe(false);
      expect(params.accept?.({ isBet: false, evento: "", selecao: "", mercado: "", odds: 0, stake: 0 })).toBe(false);
      return null;
    });
    expect(await extractBetFromImage(image, "1u", now)).toMatchObject({ bet: null, incompleteDraft: true, missing: ["odds"] });
  });
  it("recusa a primeira simples isolada quando contagem ou legenda comprovam duas", () => {
    expect(extractionContentProblem(llmBetSchema.parse({ ...raw, visibleBetCount: 2 }))).toBe("incomplete_bet_list");
    expect(extractionContentProblem(llmBetSchema.parse(raw), "1u\n0.5u")).toBe("incomplete_bet_list");
    expect(extractionContentProblem(llmBetSchema.parse(raw), "2 simples de 1u cada")).toBe("incomplete_bet_list");
  });
  it("uma simples sem odd impede aceitar o lote parcial", async () => {
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
      expect(params.accept?.({ ...raw, visibleBetCount: 2, items: [raw, { ...raw, evento: "Gamma vs Delta", selecao: "Gamma +0.25", odds: null }] })).toBe(false);
      return null;
    });
    expect(await extractBetFromImage(image, "1u cada", now)).toMatchObject({ bet: null, missing: ["odds"] });
  });
  it("não propaga o placar da primeira partida para outra simples", () => {
    const bets = mapLlmBetToParsedList({ ...raw, liveScoreHome: 1, liveScoreAway: 0,
      items: [raw, { ...raw, evento: "Gamma vs Delta", selecao: "Gamma +0.25" }] }, now);
    expect(bets?.[0]).toMatchObject({ liveScoreHome: 1, liveScoreAway: 0 });
    expect(bets?.[1]).not.toHaveProperty("liveScoreHome");
  });
  it("recupera live 0–0 da legenda sem confundi-lo com a linha AH", async () => {
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
      expect(params.accept?.(raw)).toBe(true);
      return { provider: "gemini", data: raw };
    });
    expect(await extractBetFromImage(image, "(0-0) Alpha +0.25\n1u", now)).toMatchObject({ bet: { liveScoreHome: 0, liveScoreAway: 0 } });
  });
  it("mantém 0–0 comprovado na imagem e rejeita conflito com a legenda", async () => {
    const live = { ...raw, liveScoreHome: 0, liveScoreAway: 0, liveScoreEvidence: "AO VIVO 0-0" };
    expect(mapLlmBetToParsedList(live, now)?.[0]).toMatchObject({ liveScoreHome: 0, liveScoreAway: 0 });
    expect(extractionContentProblem(llmBetSchema.parse(live), "(1-0) Alpha +0.25")).toBe("conflicting_live_score");
    expect(mapLlmBetToParsedList({ ...live, liveScoreEvidence: "(0-0)" }, now)?.[0]).toMatchObject({ liveScoreHome: 0, liveScoreAway: 0 });
    expect(mapLlmBetToParsedList({ ...live, liveScoreEvidence: undefined }, now)?.[0]).not.toHaveProperty("liveScoreHome");
    expect(extractionContentProblem(llmBetSchema.parse({ ...live, liveScoreEvidence: "Final 0-0" }))).toBe("live_score_not_at_tip");
    expect(extractionContentProblem(llmBetSchema.parse({ ...raw, liveScoreHome: 1, liveScoreAway: 0 }))).toBe("unproven_live_score");
    expect(extractionContentProblem(llmBetSchema.parse({ ...raw, liveScoreHome: 1, liveScoreAway: 0 }), "(1-0) Alpha +0.25")).toBeNull();
  });
  it("total por time exige preservar o time, além de direção e linha", () => {
    const bet = { ...raw, evento: "Corinthians vs Pinheiros", mercado: "Team Total (Points)", selecao: "Over 70.5" };
    expect(extractionContentProblem(llmBetSchema.parse(bet))).toBe("missing_selected_team");
    expect(extractionContentProblem(llmBetSchema.parse({ ...bet, selecao: "Pinheiros Over 70.5" }))).toBeNull();
  });
  it("ausências nulas não viram zero nem objetos player artificiais", () => {
    const data = llmBetSchema.parse({ ...raw, odds: null, stake: null, playerProp: null, review: null, items: null });
    expect(data.odds).toBeUndefined(); expect(data.stake).toBeUndefined(); expect(data.playerProp).toBeUndefined();
    expect(llmBetSchema.safeParse({ ...raw, playerProp: {} }).success).toBe(false);
    const schema = JSON.stringify(RESPONSE_SCHEMA);
    for (const field of ["liveScoreHome", "liveScoreAway", "liveScoreEvidence", "playerProp", "items", "visibleBetCount", "competicao"]) expect(schema).toContain(`"${field}"`);
  });
  it.each([["0.0, +0.5", "+0.25"], ["+1.0, +1.5", "+1.25"], ["0.0, -0.5", "-0.25"], ["-1.0, -1.5", "-1.25"]])("preserva financeiramente as duas pernas %s na normalização", (literal, expected) => {
    const mapped = mapLlmBetToParsedList({ ...raw, selecao: `Alpha ${literal}` }, now)![0]!;
    const mercado = pinnacleizeMercado(mapped.mercado, mapped.esporte);
    const selecao = pinnacleizeSelecao({ selecao: mapped.selecao, mercadoPinnacle: mercado, evento: mapped.evento });
    expect(canonicalizeAsianHandicapSelecao(selecao, mapped.evento, mercado)).toBe(`Alpha ${expected}`);
  });
  it("não encobre a stake omitida pela primeira leitura com o padrão da banca", async () => {
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
      expect(params.accept?.({ ...raw, stake: null })).toBe(false);
      expect(params.accept?.({ ...raw, stake: .5 })).toBe(true);
      return { provider: "groq", data: { ...raw, stake: .5 } };
    });
    expect(await extractBetFromImage(image, "", now, { stakePolicy: "WHEN_MISSING", defaultStakeUnits: 1 }))
      .toMatchObject({ bet: { stake: .5, stakePolicySnapshot: { originalStake: .5, source: "message" } } });
  });
  it("aplica o padrão autorizado só depois de esgotar leitores sem stake", async () => {
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
      const withoutStake = { ...raw, stake: null };
      params.onReading?.({ provider: "groq", model: "leitor-sem-stake", endpoint: "chat", contractHash: "c", sourceHash: "s",
        responseHash: "r", receivedAt: now.toISOString() }, withoutStake);
      expect(params.accept?.(withoutStake)).toBe(false);
      return null;
    });
    expect(await extractBetFromImage(image, "", now, { stakePolicy: "WHEN_MISSING", defaultStakeUnits: 1 }))
      .toMatchObject({ provider: "groq", bet: { stake: 1, stakePolicySnapshot: { originalStake: null, source: "bankroll_default" } } });
  });

  it("aposta de uma leitura sem o leitor identificado não é gravada: fica como provedor fora", async () => {
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
      expect(params.accept?.({ ...raw, stake: null })).toBe(false);
      return null;
    });
    expect(await extractBetFromImage(image, "", now, { stakePolicy: "WHEN_MISSING", defaultStakeUnits: 1 }))
      .toEqual({ bet: null, provider: null });
  });
});

describe("consenso entre leitores encerra a busca", () => {
  const now = new Date("2026-09-12T12:00:00Z");
  const image = { base64: "fixture", mimeType: "image/jpeg" };
  const complete = { isBet: true, evento: "Alpha vs Beta", mercado: "Asian Handicap", selecao: "Alpha +0.25", odds: 1.9, stake: 1 };
  const draft = { ...complete, odds: null };
  const notBet = { isBet: false, evento: "", selecao: "", mercado: "", odds: 0, stake: 0 };
  const reading = (provider: "gemini" | "groq" | "mistral", model: string) => ({
    provider, model, endpoint: "generate" as const, contractHash: "c", sourceHash: "s", responseHash: model, receivedAt: now.toISOString(),
  });
  /** Simula um leitor da cascata: identidade da leitura e depois o julgamento. */
  const read = (params: LlmGenerateJsonParams, provider: "gemini" | "groq" | "mistral", model: string, raw: unknown) => {
    params.onReading?.(reading(provider, model), raw);
    return params.accept?.(raw);
  };

  it("dois provedores no mesmo rascunho encerram com o rascunho", async () => {
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
      expect(read(params, "gemini", "gemini-3.1-flash-lite", draft)).toBe(false);
      expect(read(params, "groq", "qwen/qwen3.8-27b", { ...draft, evento: "ALPHA vs Beta" })).toBe(true);
      return { provider: "groq", data: draft };
    });
    expect(await extractBetFromImage(image, "1u", now)).toMatchObject({ bet: null, incompleteDraft: true, missing: ["odds"], provider: "groq" });
  });
  it("dois provedores dizendo que a imagem não é aposta encerram como não-aposta", async () => {
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
      expect(read(params, "gemini", "gemini-3.5-flash", notBet)).toBe(false);
      expect(read(params, "mistral", "mistral-ocr-4-1", notBet)).toBe(true);
      return { provider: "mistral", data: notBet };
    });
    expect(await extractBetFromImage(image, "", now)).toMatchObject({ bet: null, notBet: true });
  });
  it("modelos do mesmo provedor não encerram: o terceiro concordante só passa a vez", async () => {
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
      expect(read(params, "gemini", "gemini-3.1-flash-lite", draft)).toBe(false);
      expect(read(params, "gemini", "gemini-3.5-flash", draft)).toBe(false);
      expect(params.skipRemainingModels?.("gemini")).toBe(false);
      expect(read(params, "gemini", "gemini-2.5-flash", draft)).toBe(false);
      expect(params.skipRemainingModels?.("gemini")).toBe(true);
      expect(params.skipRemainingModels?.("groq")).toBe(false);
      return null;
    });
    expect(await extractBetFromImage(image, "1u", now)).toMatchObject({ incompleteDraft: true, missing: ["odds"] });
  });
  it("um print bom depois de dois rascunhos do mesmo provedor ainda é lido", async () => {
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
      expect(read(params, "gemini", "gemini-3-flash-preview", draft)).toBe(false);
      expect(read(params, "gemini", "gemini-3.1-flash-lite", draft)).toBe(false);
      expect(params.skipRemainingModels?.("gemini")).toBe(false);
      expect(read(params, "gemini", "gemini-3.5-flash-lite", complete)).toBe(true);
      return { provider: "gemini", data: complete };
    });
    expect(await extractBetFromImage(image, "1u", now)).toMatchObject({ bet: { odds: 1.9 } });
  });
  it("rascunhos diferentes, revisão pendente ou rascunho melhor já lido não formam consenso", async () => {
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
      expect(read(params, "gemini", "gemini-3.1-flash-lite", draft)).toBe(false);
      expect(read(params, "groq", "qwen/qwen3.8-27b", { ...draft, evento: "Gamma vs Beta" })).toBe(false);
      expect(read(params, "groq", "qwen/qwen3.8-27b", { ...complete, stake: null })).toBe(false);
      return null;
    });
    await extractBetFromImage(image, "1u", now);
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
      expect(read(params, "gemini", "gemini-3.5-flash", { ...complete, stake: null })).toBe(false);
      expect(read(params, "gemini", "gemini-3.1-flash-lite", { ...draft, stake: null })).toBe(false);
      expect(read(params, "groq", "qwen/qwen3.8-27b", { ...draft, stake: null })).toBe(false);
      return null;
    });
    expect(await extractBetFromImage(image, "", now)).toMatchObject({ incompleteDraft: true, missing: ["stake"] });
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
      expect(read(params, "gemini", "gemini-3.5-flash", { ...complete, visibleBetCount: 2 })).toBe(false);
      expect(read(params, "gemini", "gemini-3.1-flash-lite", draft)).toBe(false);
      expect(read(params, "groq", "qwen/qwen3.8-27b", draft)).toBe(false);
      return null;
    });
    expect(await extractBetFromImage(image, "1u", now)).toMatchObject({ review: { reason: "incomplete_bet_list" } });
  });
});

describe("leituras numéricas e placar sem invenção", () => {
  const NOW = new Date("2026-09-12T12:00:00Z");
  const raw = { isBet: true, evento: "Slovan Liberec vs Mlada Boleslav", mercado: "Total (Corners) – Match", selecao: "Over 10.0", odds: 1.9, stake: 0.25 };


  it("uma omissão numérica continua o fallback e preserva rascunho ao esgotar leitores", async () => {
    const { odds: _odds, ...withoutOdds } = raw;
    const acceptance: boolean[] = [];
    mocks.generate.mockImplementation(async params => {
      acceptance.push(Boolean(params.accept?.(withoutOdds)));
      return null;
    });
    const result = await extractBetFromImage({ base64: "fixture", mimeType: "image/jpeg" }, "1u", NOW, { capturePolicy: "IMAGE_ODD" });
    expect(acceptance).toEqual([false]);
    expect(result).toMatchObject({ bet: null, incompleteDraft: true, missing: ["odds"] });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  it("diagnóstico: 0–0 inventado é removido antes da classificação temporal", () => {
    const parsed = mapLlmBetToParsed({ ...raw, liveScoreHome: 0, liveScoreAway: 0 }, NOW);
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("liveScoreHome");
    expect(entrouAoVivo({ registradoEm: NOW, sourcePostedAt: NOW, kickoff: new Date("2026-09-12T13:00:00Z"), liveScoreHome: parsed?.liveScoreHome, liveScoreAway: parsed?.liveScoreAway })).toBe(false);
  });

  it("diagnóstico: ausência numérica permitida pelo contrato não significa número inventado", () => {
    expect(RESPONSE_SCHEMA.required).toContain("odds");
    expect(RESPONSE_SCHEMA.required).toContain("stake");
    expect(llmBetSchema.safeParse({ ...raw, odds: 0, stake: 0 }).success).toBe(true);
    expect(mapLlmBetToParsed({ ...raw, odds: 0, stake: 0 }, NOW)).toBeNull();
  });

  it("diagnóstico: playerProp vazio invalida campos principais corretos", () => {
    const withDummyPlayer = { ...raw, playerProp: { jogador: "", mercadoOriginal: "", selecaoOriginal: "", substituicao: "UNKNOWN" } };
    expect(llmBetSchema.safeParse(withDummyPlayer).success).toBe(false);
    expect(mapLlmBetToParsed(withDummyPlayer, NOW)).toBeNull();
  });

  it("a resposta não-aposta prescrita pelo prompt passa pelo validador", () => {
    const notBet = { isBet: false, evento: "", mercado: "", selecao: "", odds: 0, stake: 0 };
    const parsed = llmBetSchema.safeParse(notBet);
    expect(parsed.success).toBe(true);
  });
});

describe("revisão por conflito e contrato", () => {
  const now = new Date("2026-09-12T12:00:00Z");
  const raw = { isBet: true, evento: "Bath City vs Chippenham Town", mercado: "Asian Handicap", selecao: "Chippenham Town +0.5", odds: 1.925, stake: 1 };
  const photo = () => extractBetFromImage({ mimeType: "image/png", base64: "test" }, "", now);

  it("retains an OCR line conflict for review when the cascade is exhausted", async () => {
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => { params.onOcrConflict?.(raw); return null; });
    const result = await photo();
    expect(result).toMatchObject({ bet: null, incompleteDraft: true, review: { reason: "ocr_split_handicap_conflict", evidence: raw } });
  });

  it("a later valid model can resolve the capture after an OCR veto", async () => {
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
      params.onOcrConflict?.(raw);
      return { provider: "mistral", data: { ...raw, selecao: "Chippenham Town +0.25" } };
    });
    expect(await photo()).toMatchObject({ provider: "mistral", bet: { selecao: "Chippenham Town +0.25", odds: 1.925, stake: 1 } });
  });

  it("a negative classification cannot discard a previously detected line conflict", async () => {
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
      params.onOcrConflict?.(raw); return { provider: "mistral", data: { isBet: false } };
    });
    expect(await photo()).toMatchObject({ bet: null, incompleteDraft: true, review: { reason: "ocr_split_handicap_conflict" } });
  });

  it("an incomplete structured response is reviewed after fallback attempts", async () => {
    const partial = { isBet: true, evento: "Germany", selecao: "", mercado: "", odds: 1.86, stake: 0 };
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => { expect(params.accept?.(partial)).toBe(false); return null; });
    expect(await extractBetFromText("Alemanha odd 1,86", now)).toMatchObject({ bet: null, incompleteDraft: true, review: { reason: "incomplete_extraction", evidence: partial } });
  });

  it("a leitura de texto leva a referência da mensagem para o painel", async () => {
    mocks.generate.mockResolvedValue(null);
    await extractBetFromText("Alemanha odd 1,86", now, undefined, { chatIdHash: "abc123def4567890", messageId: 88 });
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ label: "channel-text", itemRef: { chatIdHash: "abc123def4567890", messageId: 88 } }));
  });

  it("provedor fora do ar continua relançável", async () => {
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => { expect(params.accept?.({ isBet: "yes", evento: "Germany" })).toBe(false); return null; });
    expect(await photo()).toEqual({ bet: null, provider: null });
  });

  it("um provedor recusou e outro não foi ouvido: relança com a recusa que vale no fim das tentativas", async () => {
    mocks.exhaustion = { kind: "unavailable", responded: true };
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => { expect(params.accept?.({ isBet: "yes", evento: "Germany" })).toBe(false); return null; });
    expect(await photo()).toEqual({ bet: null, provider: null, refusalWhenExhausted: { reason: "leitura_recusada_com_provedor_fora" } });
  });

  it("todos os provedores responderam e recusaram: recusa, não relança", async () => {
    mocks.exhaustion = { kind: "refused" };
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => { expect(params.accept?.({ isBet: "yes", evento: "Germany" })).toBe(false); return null; });
    expect(await photo()).toEqual({ bet: null, provider: null, refused: { reason: "leitura_recusada_pela_ia", provider: null } });
  });

  it("recusa de todos com revisão pendente continua sendo revisão", async () => {
    mocks.exhaustion = { kind: "refused" };
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => { params.onOcrConflict?.(raw); return null; });
    expect(await photo()).toMatchObject({ bet: null, incompleteDraft: true, review: { reason: "ocr_split_handicap_conflict" } });
    expect(await photo()).not.toHaveProperty("refused");
  });

  it("seleção da legenda fora do print é recusada pelo juiz, não depois dele", async () => {
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
      expect(params.accept?.(raw)).toBe(false);
      return null;
    });
    const result = await extractBetFromImage({ mimeType: "image/png", base64: "test" }, "Bath City +1.5", now);
    expect(result).toMatchObject({ bet: null, incompleteDraft: true, review: { reason: "selecao_diverge_legenda" } });
    expect(result).not.toHaveProperty("refused");
  });

  it("a structured bet with invalid fields becomes a review, not a provider outage", async () => {
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
      expect(params.accept?.({ isBet: true, odds: 1.8, stake: .5, playerProp: {} })).toBe(false);
      return null;
    });
    expect(await extractBetFromText("Faz com 0.50u @1.80", now)).toMatchObject({ bet: null, incompleteDraft: true, review: { reason: "invalid_extraction_contract" } });
  });
  it("missing all selection fields remains visible for review", async () => {
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
      expect(params.accept?.({ isBet: true, odds: 1.8, stake: .5 })).toBe(false);
      return null;
    });
    expect(await extractBetFromText("Faz com 0.50u @1.80", now)).toMatchObject({ bet: null, incompleteDraft: true, review: { reason: "incomplete_extraction" } });
  });
  it("a later usable provider still wins after a contract rejection", async () => {
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
      expect(params.accept?.({ isBet: true, playerProp: {} })).toBe(false);
      return { provider: "groq", data: raw };
    });
    expect(await photo()).toMatchObject({ provider: "groq", bet: { odds: 1.925 } });
  });
});

describe("fallback OCR com perfil de imagem qualificado", () => {
  beforeEach(() => { mocks.profile.mockResolvedValue("compact-bet365-slip-v1"); });

  it.each<CapturePolicy>(["AUTO", "CAPTION_ODD", "IMAGE_ODD"])("mantém o fallback OCR no fluxo de imagem com política %s", async (capturePolicy) => {
    mocks.generate.mockImplementation(async (params) => {
      expect(params.ocrImageProfile).toBe("compact-bet365-slip-v1");
      expect(params.ocrResponseSchema).toBeDefined();
      const data = params.ocrNormalize?.({ isBet: true, evento: "Raith vs Arbroath", mercado: "Total de Escanteios Asiáticos", selecao: "Menos de 9.0", odds: 1.825, stake: 0, dataTexto: "" });
      expect(params.ocrAccept?.(data)).toBe(true);
      expect(params.accept?.(data)).toBe(true);
      return { data, provider: "mistral" };
    });
    const result = await extractBetFromImage({ base64: "fixture", mimeType: "image/jpeg" }, "Will / SL\n0.25u @1.925", new Date("2026-09-12T13:44:18Z"), { capturePolicy });
    // A leitura guarda a odd do print; quem aplica a política da banca é o guard.
    expect(result).toMatchObject({ provider: "mistral", bet: { evento: "Raith vs Arbroath", odds: 1.825, stake: .25 } });
  });
});

describe("regra da odd na leitura do print", () => {
  const raw = { isBet: true, evento: "Alpha vs Beta", mercado: "Moneyline", selecao: "Alpha", odds: 2.1, stake: 1 };
  const caption = "Alpha ML @18.5 1u";
  const now = new Date("2026-09-23T12:00:00Z");
  const readingText = (params: LlmGenerateJsonParams) => params.parts.flatMap((part) => ("text" in part ? [part.text] : [])).join("\n");

  it.each<CapturePolicy>(["AUTO", "IMAGE_ODD"])("banca %s: legenda @18.5 e print 2,10 → o pedido manda usar a odd do print", async (capturePolicy) => {
    let sent: LlmGenerateJsonParams | undefined;
    mocks.generate.mockImplementation(async (params) => {
      sent = params;
      return { data: raw, provider: "gemini" };
    });
    const result = await extractBetFromImage({ base64: "fixture", mimeType: "image/jpeg" }, caption, now, { capturePolicy });
    expect(sent?.systemInstruction).toContain("Vale a odd do PRINT");
    expect(readingText(sent!)).not.toContain("Política desta banca");
    expect(readingText(sent!)).toContain("<legenda>\nAlpha ML @18.5 1u\n</legenda>");
    expect(result).toMatchObject({ provider: "gemini", bet: { odds: 2.1 } });
  });

  it("banca CAPTION_ODD: o pedido também pede a odd do print, e o guard recusa a divergência grande", async () => {
    let sent: LlmGenerateJsonParams | undefined;
    mocks.generate.mockImplementation(async (params) => {
      sent = params;
      return { data: { ...raw, odds: 1.85 }, provider: "gemini" };
    });
    const result = await extractBetFromImage({ base64: "fixture", mimeType: "image/jpeg" }, caption, now, { capturePolicy: "CAPTION_ODD" });
    expect(readingText(sent!)).not.toMatch(/pol[ií]tica/i);
    expect(result.bet?.odds).toBe(1.85);
    expect(finalizeParsedBetForCapture(result.bet!, caption, "CAPTION_ODD", { readFromImage: true }))
      .toEqual({ ok: false, missing: ["odds"], reason: "odd_diverge_legenda" });
  });

  it("aba 'Handicap' da Bet365 com linha inteira: a leitura fica 'Handicap' e o guard pergunta o tipo", async () => {
    const tab = { isBet: true, evento: "Flamengo vs Palmeiras", mercado: "Handicap", selecao: "Flamengo -1", odds: 2.2, stake: 1 };
    mocks.generate.mockResolvedValue({ data: tab, provider: "gemini" });
    const result = await extractBetFromImage({ base64: "fixture", mimeType: "image/jpeg" }, "1u", now);
    expect(result.bet).toMatchObject({ mercado: "Handicap", selecao: "Flamengo -1" });
    expect(finalizeParsedBetForCapture(result.bet!, "1u", "AUTO", { readFromImage: true }))
      .toEqual({ ok: false, missing: ["mercado"], reason: "handicap_tipo_ambiguo" });
    // Canal marcado só com basquete: sem empate, a linha inteira é asiática.
    expect(finalizeParsedBetForCapture(result.bet!, "1u", "AUTO", { readFromImage: true, channelSports: ["Basketball"] }))
      .toMatchObject({ ok: true });
  });

  it("um leitor viu a grade sem a opção marcada: outro que escolheu um lado não é aceito", async () => {
    const unmarked = { isBet: true, evento: "CSD Municipal vs Suchitepequez", mercado: "Handicap Asiático", selecao: "", odds: null, stake: 1,
      review: { reason: "unmarked_selection", description: "CSD Municipal -1.5,-2.0 @1.800 | Suchitepequez +1.5,+2.0 @2.000",
        options: [{ selecao: "CSD Municipal -1.5,-2.0", odds: "1.800" }, { selecao: "Suchitepequez +1.5,+2.0", odds: 2 }] } };
    const guess = { isBet: true, evento: "CSD Municipal vs Suchitepequez", mercado: "Handicap – Match", selecao: "CSD Municipal -1.5,-2.0", odds: 1.8, stake: 1 };
    mocks.generate.mockImplementation(async (params) => {
      expect(params.accept?.(unmarked)).toBe(false);
      expect(params.accept?.(guess)).toBe(false);
      return null;
    });
    // As opções listadas vão para a pergunta na DM, com o resto da leitura.
    expect(await extractBetFromImage({ base64: "fixture", mimeType: "image/jpeg" }, "1u", now)).toMatchObject({
      bet: null, incompleteDraft: true, review: { reason: "unmarked_selection" },
      gridChoice: {
        bet: { evento: "CSD Municipal vs Suchitepequez", selecao: "CSD Municipal -1.5,-2.0", odds: 1.8, stake: 1 },
        options: [{ selecao: "CSD Municipal -1.5,-2.0", odds: 1.8 }, { selecao: "Suchitepequez +1.5,+2.0", odds: 2 }],
      },
    });
  });
});

describe("odd mínima como único preço", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  const text = "Jogo: Flamengo x Palmeiras\nEntrada: Over 2.5 gols\nOdd mín: 1.70\nStake: 1u";
  const reading = { isBet: true, evento: "Flamengo vs Palmeiras", mercado: "Total – Match", selecao: "Over 2.5", odds: null, stake: 1 };

  it("não espera outro leitor: a leitura segue sem a odd, e o guard a recusa pedindo a odd", async () => {
    mocks.generate.mockImplementation(async (params) => {
      expect(params.accept?.(reading)).toBe(true);
      return { data: reading, provider: "groq" };
    });
    const result = await extractBetFromText(text, now);
    expect(result).toMatchObject({ bet: null, incompleteDraft: true, missing: ["odds"],
      withoutOdds: [{ evento: "Flamengo vs Palmeiras", mercado: "Total – Match", selecao: "Over 2.5", odds: 0, stake: 1 }] });
    expect(finalizeParsedBetForCapture(result.withoutOdds![0]!, text, "AUTO"))
      .toEqual({ ok: false, missing: ["odds"], reason: "odd_invalida" });
  });

  it("sem a mínima, a odd ausente continua rascunho à espera da edição", async () => {
    mocks.generate.mockImplementation(async (params) => {
      expect(params.accept?.(reading)).toBe(false);
      return null;
    });
    const result = await extractBetFromText(text.replace("Odd mín: 1.70\n", ""), now);
    expect(result).toMatchObject({ bet: null, incompleteDraft: true, missing: ["odds"] });
    expect(result.withoutOdds).toBeUndefined();
  });
});

describe("stake fixa da banca", () => {
  const raw = { isBet: true, evento: "Alpha vs Beta", mercado: "Moneyline", selecao: "Alpha", odds: 1.72, stake: null };
  const now = new Date("2026-09-13T03:00:00Z");
  const fixed = { stakePolicy: "ALWAYS" as const, defaultStakeUnits: 1 };
  const image = { base64: "synthetic-image", mimeType: "image/png" };

  it.each([null, 0, .25])("aceita na primeira leitura com stake fixa sem atribuir ao OCR o valor da banca: %s", async (stake) => {
    const data = { ...raw, stake }, snapshot = structuredClone(data);
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
      expect(params.stakePolicy).toBe("ALWAYS");
      expect(params.contentState?.(data)).toBe("complete");
      expect(params.sourceContentState?.(data)).toBe(stake ? "complete" : "draft");
      params.onReading?.({ provider: "gemini", model: "test", endpoint: "generate", sourceHash: "source", responseHash: "response", contractHash: "contract", receivedAt: now.toISOString() }, data);
      expect(params.accept?.(data)).toBe(true);
      expect(data).toEqual(snapshot);
      return { provider: "gemini", data };
    });
    const result = await extractBetFromImage(image, "", now, fixed);
    expect(result.bet).toMatchObject({ odds: 1.72, stake: 1, stakePolicySnapshot: { stakePolicy: "ALWAYS", originalStake: stake, source: "bankroll_fixed" } });
    expect(result.ocrEvidence).toMatchObject({ state: "complete", sourceFields: { stake }, transformations: expect.arrayContaining(["bankroll_fixed"]) });
  });

  it.each([
    { ...raw, odds: null },
    { ...raw, evento: "Alpha vs TBD" },
    { ...raw, mercado: "Team Total (Points)", selecao: "Over 70.5" },
    { ...raw, liveScoreHome: 1, liveScoreAway: 0 },
    { ...raw, visibleBetCount: 2 },
    { ...raw, review: { reason: "incomplete_fixture", description: "Confronto cortado" } },
  ])("stake fixa não dispensa odd, confronto, seleção, contagem ou evidência", async (data) => {
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => { expect(params.accept?.(data)).toBe(false); return null; });
    expect((await extractBetFromImage(image, "", now, fixed)).bet).toBeNull();
  });

  it("stake fixa não aceita placar que conflita com a legenda", async () => {
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => { expect(params.accept?.({ ...raw, liveScoreHome: 0, liveScoreAway: 0, liveScoreEvidence: "AO VIVO 0-0" })).toBe(false); return null; });
    expect((await extractBetFromImage(image, "(1-0) Alpha ML", now, fixed)).bet).toBeNull();
  });

  it("mantém ausência de stake como rascunho quando a política exige a mensagem", async () => {
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => { expect(params.accept?.(raw)).toBe(false); return null; });
    expect(await extractBetFromImage(image, "", now, { stakePolicy: "MESSAGE" })).toMatchObject({ bet: null, incompleteDraft: true, missing: ["stake"] });
  });

  it("exige odd em cada simples e aplica stake fixa por item sem herdar números da raiz", async () => {
    const second = { ...raw, evento: "Gamma vs Delta", selecao: "Gamma", odds: 2.1 };
    const data = { ...raw, ticketType: "singles", visibleBetCount: 2, items: [raw, second] };
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
      expect(params.accept?.({ ...data, items: [raw, { ...second, odds: null }] })).toBe(false);
      expect(params.accept?.(data)).toBe(true);
      return { provider: "gemini", data };
    });
    const result = await extractBetFromImage(image, "", now, fixed);
    expect(result.bets).toHaveLength(2);
    expect(result.bets?.map((bet) => [bet.odds, bet.stake, bet.stakePolicySnapshot?.originalStake])).toEqual([[1.72, 1, null], [2.1, 1, null]]);
  });

  it("preserva a conciliação de linha da legenda mesmo com stake fixa", async () => {
    const data = { ...raw, mercado: "Total (Corners)", selecao: "Over 9.5" };
    mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => { expect(params.accept?.(data)).toBe(false); return null; });
    expect((await extractBetFromImage(image, "Over 10.5 escanteios", now, fixed)).bet).toBeNull();
  });
});

describe("odd ou stake ausentes viram rascunho", () => {
  const NOW = new Date("2026-06-15T19:00:00Z");

  it("extractBetFromText com stake=0 retorna incompleteDraft=true sem persistir aposta nem inventar stake", async () => {
    mocks.generate.mockResolvedValueOnce({
      provider: "gemini",
      data: {
        isBet: true,
        evento: "Real Madrid vs Barcelona",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "Real Madrid",
        odds: 2.2,
        stake: 0,
      },
    });

    const result = await extractBetFromText("Dica: Real Madrid vs Barcelona @ 2.20", NOW);
    expect(result.bet).toBeNull();
    expect(result.incompleteDraft).toBe(true);
    expect(result.missing).toEqual(["stake"]);
    expect(result.provider).toBe("gemini");
  });

  it("extractBetFromText com stake omitida retorna incompleteDraft=true", async () => {
    mocks.generate.mockResolvedValueOnce({
      provider: "gemini",
      data: {
        isBet: true,
        evento: "Real Madrid vs Barcelona",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "Real Madrid",
        odds: 2.2,
      },
    });

    const result = await extractBetFromText("Dica: Real Madrid vs Barcelona @ 2.20", NOW);
    expect(result.bet).toBeNull();
    expect(result.incompleteDraft).toBe(true);
    expect(result.missing).toEqual(["stake"]);
  });

  it("extractBetFromText com odd=0 retorna incompleteDraft=true com missing incluindo odds", async () => {
    mocks.generate.mockResolvedValueOnce({
      provider: "gemini",
      data: {
        isBet: true,
        evento: "Real Madrid vs Barcelona",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "Real Madrid",
        odds: 0,
        stake: 1,
      },
    });

    const result = await extractBetFromText("Dica: Real Madrid vs Barcelona (1u)", NOW);
    expect(result.bet).toBeNull();
    expect(result.incompleteDraft).toBe(true);
    expect(result.missing).toEqual(["odds"]);
    expect(result.missing).toEqual(["odds"]);
  });

  it("extractBetFromText com odd omitida retorna incompleteDraft=true com missing incluindo odds", async () => {
    mocks.generate.mockResolvedValueOnce({
      provider: "gemini",
      data: {
        isBet: true,
        evento: "Real Madrid vs Barcelona",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "Real Madrid",
        stake: 1,
      },
    });

    const result = await extractBetFromText("Dica: Real Madrid vs Barcelona (1u)", NOW);
    expect(result.bet).toBeNull();
    expect(result.incompleteDraft).toBe(true);
    expect(result.missing).toEqual(["odds"]);
  });
});

describe("bilhete Betano com duas simples e valores na legenda", () => {
  const image = { base64: "fixture", mimeType: "image/jpeg" };
  const caption = "Igux Props VIP\n1.75u\n0.75u\nhttps://www.betano.bet.br/bookingcode/JJ85CHBA/";
  const now = new Date("2026-09-09T11:03:36Z");

  function respond(data: unknown) {
    mocks.generate.mockImplementation(async (params) => {
      params.onReading?.({ provider: "gemini", model: "synthetic-model", endpoint: "generate", contractHash: "a".repeat(64), sourceHash: "b".repeat(64), responseHash: "c".repeat(64), receivedAt: now.toISOString() }, data);
      return params.accept?.(data) ? { data, provider: "gemini" } : null;
    });
  }

  it("preserva a seleção recusada para revisão mesmo se o fallback disser que não é aposta", async () => {
    const grid = { isBet: true, evento: "Basquete Femi... vs Joinville BC / S...", mercado: "Asian Handicap", selecao: "Basquete Femi... -48.5", odds: 1.86, stake: 1, liveScoreHome: null, liveScoreAway: null };
    mocks.generate.mockImplementation(async (params) => {
      expect(params.accept?.(grid)).toBe(false);
      return { data: { isBet: false }, provider: "groq" };
    });
    expect(await extractBetFromImage(image, "Blumenau -48.5 HA @1.86\n1u", now)).toMatchObject({ bet: null, incompleteDraft: true, review: { evidence: grid } });
    mocks.generate.mockImplementation(async (params) => {
      expect(params.accept?.(grid)).toBe(false);
      return null;
    });
    expect(await extractBetFromImage(image, "Blumenau -48.5 HA @1.86\n1u", now)).toMatchObject({ bet: null, incompleteDraft: true, review: { evidence: grid } });
  });
  it.each(["São José vs Adversário", "Basquete Femi... vs Joinville BC / S...", "Blumenau vs -48.5 HA"])("não cria identidade com confronto incompleto: %s", async (evento) => {
    respond({ isBet: true, evento, mercado: "Moneyline", selecao: "São José", odds: 4.29, stake: .25 });
    expect(await extractBetFromText("Seleções sem confrontos completos", now)).toMatchObject({ bet: null, incompleteDraft: true, review: { reason: "incomplete_fixture" } });
  });
  it("dupla explícita com preço único fica para revisão sem virar duas simples ou falha da API", async () => {
    respond({ isBet: true, items: [], review: { reason: "combined_player_ticket", description: "Thaciano chutes no alvo Over 1.5 + marcar", evento: "Santos vs Atlético-MG", selecao: "Chutes no alvo + marcar", odds: 16, stake: .5 } });
    expect(await extractPlayerBetsFromImage(image, "Igux Props VIP", now)).toMatchObject({ bet: null, incompleteDraft: true, missing: ["combined_player_ticket"], review: { evidence: { odds: 16, stake: .5 } } });
  });
  it("solicita todos os itens e números e conserva cada linha, odd e stake", async () => {
    respond(playerSlips);
    const result = await extractPlayerBetsFromImage(image, caption, now);
    expect(result.bets?.map((b) => [buildPlayerPropTerms(b)?.lineQuarters, b.odds, b.stake])).toEqual([[10, 2.95, 1.75], [14, 6, .75]]);
    expect(result.bets?.every((b) => buildPlayerPropTerms(b)?.family === "shots_total")).toBe(true);
    const schema = mocks.generate.mock.calls[0]![0].responseSchema;
    expect(schema).toMatchObject({ required: expect.arrayContaining(["isBet", "items", "visibleBetCount"]), properties: { items: { items: { required: expect.arrayContaining(["odds", "stake", "playerProp"]) } } } });
  });
  it("artilheiro e chutes no alvo da mesma jogadora são duas simples completas", async () => {
    const pp = (mercado: string, selecao: string) => ({ jogador: "Estela Carbonell", mercadoOriginal: mercado, selecaoOriginal: selecao, substituicao: "UNKNOWN", evidencia: "" });
    respond({ isBet: true, ticketType: "singles", visibleBetCount: 2, items: [
      { evento: "Juventus (F) vs Benfica (F)", mercado: "Para Marcar a Qualquer Momento", selecao: "Estela Carbonell", odds: 7.5, stake: 0.5, stakeSource: "image_units", playerProp: pp("Para Marcar a Qualquer Momento", "Estela Carbonell") },
      { evento: "Juventus (F) vs Benfica (F)", mercado: "Jogador - Chutes ao Gol", selecao: "Estela Carbonell - Mais de 0.5", odds: 3.25, stake: 0.5, stakeSource: "image_units", playerProp: pp("Jogador - Chutes ao Gol", "Estela Carbonell - Mais de 0.5") },
    ] });
    const result = await extractPlayerBetsFromImage(image, "Igux Props VIP", now);
    expect(result.bets?.map((b) => [b.mercado, b.odds, b.stake])).toEqual([
      ["Para Marcar a Qualquer Momento", 7.5, 0.5], ["Jogador - Chutes ao Gol", 3.25, 0.5],
    ]);
  });
  it("pontos de jogadora no basquete: completa com jogador, lado e linha num mercado de jogador", async () => {
    const reading = (mercado: string, selecao: string) => ({ isBet: true, ticketType: "single", visibleBetCount: 1, items: [
      { evento: "Las Vegas Aces (F) vs Los Angeles Sparks (F)", mercado, selecao, odds: 1.93, stake: 1.5, stakeSource: "caption", esporte: "Basketball",
        playerProp: { jogador: "A'ja Wilson", mercadoOriginal: "Total de pontos [A'ja Wilson]", selecaoOriginal: "Menos de 27.5", substituicao: "UNKNOWN", evidencia: "" } },
    ] });
    respond(reading("Player Points", "A'ja Wilson Under 27.5"));
    expect((await extractPlayerBetsFromImage(image, "1.5u", now)).bets).toMatchObject([{ mercado: "Player Points", selecao: "A'ja Wilson Under 27.5", odds: 1.93 }]);
    // "Total de pontos" sem se declarar de jogador seria gravado como total do jogo.
    respond(reading("Total de pontos", "Menos de 27.5"));
    expect(await extractPlayerBetsFromImage(image, "1.5u", now)).toMatchObject({ bet: null, incompleteDraft: true, missing: ["incomplete_player_terms"] });
  });
  it.each([
    ["Cestas de 3 pontos [Stephen Curry]", "Stephen Curry Mais de 4.5"],
    ["Player Points 1st Quarter", "Stephen Curry Over 8.5"],
  ])("outra estatística de jogador no basquete (%s) fica na revisão, sem gravar", async (mercado, selecao) => {
    respond({ isBet: true, ticketType: "single", visibleBetCount: 1, items: [
      { evento: "Golden State Warriors vs Los Angeles Lakers", mercado, selecao, odds: 1.9, stake: 1, stakeSource: "caption", esporte: "Basketball",
        playerProp: { jogador: "Stephen Curry", mercadoOriginal: mercado, selecaoOriginal: selecao, substituicao: "UNKNOWN", evidencia: "" } },
    ] });
    expect(await extractPlayerBetsFromImage(image, "1u", now)).toMatchObject({ bet: null, incompleteDraft: true });
  });
  it("álbum usa o mesmo contrato de lista sem perder a segunda simples", async () => {
    respond(playerSlips);
    expect((await extractBetsFromImages([image, image], caption, now)).bets).toHaveLength(2);
  });
  it("número ausente vira rascunho e não indisponibilidade da API", async () => {
    const missing = structuredClone(playerSlips); missing.items[1]!.stake = 0;
    respond(missing);
    expect(await extractPlayerBetsFromImage(image, "sem stake", now)).toMatchObject({ bet: null, provider: "gemini", incompleteDraft: true, missing: ["stake"] });
  });
  it("não perde uma simples quando sua odd está ausente", async () => {
    const missing = structuredClone(playerSlips); missing.items[1]!.odds = 0;
    respond(missing);
    expect(await extractPlayerBetsFromImage(image, caption, now)).toMatchObject({ bet: null, incompleteDraft: true, missing: ["odds"] });
  });
  it("continua recusando seleção sem linha e distingue conteúdo que não é aposta", async () => {
    const missing = structuredClone(playerSlips); missing.items[1]!.selecao = "Rasmus Hojlund";
    respond(missing);
    expect(await extractPlayerBetsFromImage(image, caption, now)).toMatchObject({ bet: null, provider: null });
    respond({ isBet: false, items: [] });
    expect(await extractPlayerBetsFromImage(image, caption, now)).toMatchObject({ bet: null, provider: "gemini", notBet: true });
  });
});


it("releitura não apaga freebet comprovada por outro leitor", async () => {
  const raw = { isBet: true, evento: "Alpha vs Beta", mercado: "Moneyline", selecao: "Alpha", odds: 2, stake: 1 };
  mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
    expect(params.accept?.({ ...raw, promotionEvidence: "Freebet usada: 1u" })).toBe(false);
    expect(params.accept?.({ ...raw, review: { reason: "ambiguous_bet", description: "Mercado incerto" } })).toBe(false);
    expect(params.accept?.(raw)).toBe(false);
    return null;
  });
  expect(await extractBetFromImage({ base64: "fixture", mimeType: "image/jpeg" }, "1u", new Date("2026-09-12T12:00:00Z")))
    .toMatchObject({ bet: null, missing: ["unsupported_promotion_terms"], review: { reason: "unsupported_promotion_terms", description: expect.stringContaining("Freebet usada: 1u"), evidence: expect.objectContaining({ promotionEvidence: "Freebet usada: 1u" }) } });
});


it.each(["Nenhuma", "null", "N/A", "Não há", "Odd turbinada"])("evidência %j não recusa nem trava as releituras", async (text) => {
  const raw = { isBet: true, evento: "Alpha vs Beta", mercado: "Moneyline", selecao: "Alpha", odds: 2, stake: 1 };
  const filled = { ...raw, promotionEvidence: text, operationEvidence: text };
  mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
    expect(params.accept?.(filled)).toBe(true);
    return { data: filled, provider: "gemini" };
  });
  expect(await extractBetFromText("Alpha vs Beta\nAlpha ML @2.00 1u", new Date("2026-09-12T12:00:00Z")))
    .toMatchObject({ bet: { selecao: "Alpha", odds: 2, stake: 1 }, provider: "gemini" });
});

it("no post de texto, a prova que não está escrita nele é ignorada e a que está recusa", async () => {
  const raw = { isBet: true, evento: "Alpha vs Beta", mercado: "Moneyline", selecao: "Alpha", odds: 2, stake: 1, promotionEvidence: "Freebet usada: 1u" };
  mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) =>
    params.accept?.(raw) ? { data: raw, provider: "gemini" } : null);
  expect(await extractBetFromText("Alpha vs Beta\nAlpha ML @2.00 1u", new Date("2026-09-12T12:00:00Z")))
    .toMatchObject({ bet: { selecao: "Alpha" }, provider: "gemini" });
  expect(await extractBetFromText("Alpha vs Beta\nAlpha ML @2.00\nhoje é freebet usada: 1u", new Date("2026-09-12T12:00:00Z")))
    .toMatchObject({ bet: null, review: { reason: "unsupported_promotion_terms", description: expect.stringContaining("Freebet usada: 1u") } });
});

it.each(["Alpha", ""])("releitura não apaga lay comprovado mesmo com seleção %j", async (selecao) => {
  const raw = { isBet: true, evento: "Alpha vs Beta", mercado: "Moneyline", selecao: "Alpha", odds: 4, stake: 1 };
  mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
    expect(params.accept?.({ ...raw, selecao, operationEvidence: "Lay Alpha, responsabilidade 3u" })).toBe(false);
    expect(params.accept?.(raw)).toBe(false);
    return null;
  });
  expect(await extractBetFromImage({ base64: "fixture", mimeType: "image/jpeg" }, "1u", new Date("2026-09-12T12:00:00Z")))
    .toMatchObject({ bet: null, missing: ["unsupported_trading_terms"], review: { reason: "unsupported_trading_terms", description: expect.stringContaining("Lay Alpha, responsabilidade 3u"), evidence: expect.objectContaining({ operationEvidence: "Lay Alpha, responsabilidade 3u" }) } });
});

it("prova de lay prevalece sobre divergência anterior de seleção", async () => {
  const raw = { isBet: true, evento: "Alpha vs Beta", mercado: "Moneyline", selecao: "Alpha", odds: 4, stake: 1 };
  mocks.generate.mockImplementation(async (params: LlmGenerateJsonParams) => {
    expect(params.accept?.(raw)).toBe(false);
    expect(params.accept?.({ ...raw, operationEvidence: "Lay Alpha: responsabilidade 3u" })).toBe(false);
    return null;
  });
  expect(await extractBetFromImage({ base64: "fixture", mimeType: "image/jpeg" }, "Gamma +1.5", new Date("2026-09-12T12:00:00Z")))
    .toMatchObject({ bet: null, review: { reason: "unsupported_trading_terms", description: expect.stringContaining("responsabilidade 3u") } });
});
