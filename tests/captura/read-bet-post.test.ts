import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureImage, ParsedBetPost } from "@/src/domain/bet-capture";
import type { CaptureStakeSettings } from "@/src/domain/capture-stake-policy";

const extract = vi.hoisted(() => ({
  extractBetFromText: vi.fn(),
  extractBetFromImage: vi.fn(),
  extractBetsFromImages: vi.fn(),
  extractPlayerBetsFromImage: vi.fn(),
}));
vi.mock(import("@/src/services/capture/reading/extract-bet"), () => extract);

import { readBetPost, type ReadingContext } from "@/src/services/capture/reading/read-bet-post";

const NOW = new Date("2026-06-10T12:00:00Z");
const TIP = ["⚽ Coquimbo Unido vs Colo Colo", "Data: 15/06 16:00", "Entrada: Casa", "ODD: 2.10", "Stake: 1u"].join("\n");
/** Tem cara de aposta, mas a regra não lê: vai à IA. */
const UNREAD = ["🎾 Sinner vs Fritz", "Entrada: +22.5", "@1.90", "1u"].join("\n");

const channel = (gates: Partial<ReadingContext["gates"]> = {}): ReadingContext => ({
  now: NOW, gates: { recap: true, draft: true, ...gates },
});
/** O texto do canal passa pelo filtro anti-ruído; sem ele (`null`), é o pedido do dono ou a DM. */
const read = (text: string, context = channel(), noiseFilter: { stakeSettings: CaptureStakeSettings } | null = { stakeSettings: {} }) =>
  readBetPost({ kind: "text", text, ...(noiseFilter ? { noiseFilter } : {}) }, context);

function bet(overrides: Partial<ParsedBetPost> = {}): ParsedBetPost {
  return {
    evento: "Sinner vs Fritz", esporte: "Tennis", competicao: "", pais: "", mercado: "Handicap", selecao: "Sinner +22.5",
    odds: 1.9, stake: 1, data: null, casaDeAposta: "", ...overrides,
  };
}

beforeEach(() => {
  for (const mock of Object.values(extract)) mock.mockReset();
});

describe("porteiros antes da IA", () => {
  it("recapitulação e post sem cara de aposta param antes da regra virar aposta", async () => {
    expect(await read(`${TIP}\n✅ GREEN`)).toEqual({ kind: "skipped", reason: "resultado_ou_balanco" });
    expect(await read("Bom dia família! 🌞")).toEqual({ kind: "skipped", reason: "nao_parece_aposta" });
    expect(extract.extractBetFromText).not.toHaveBeenCalled();
  });

  it("sem os porteiros (DM, captura pedida pelo dono) o post vai à leitura", async () => {
    extract.extractBetFromText.mockResolvedValue({ bet: null, provider: "gemini", notBet: true });
    expect(await read("Bom dia família! 🌞", channel(), null)).toMatchObject({ kind: "not_bet" });
    expect(await read(`${TIP}\n✅ GREEN`, channel({ recap: false }))).toMatchObject({ kind: "bets", via: "universal" });
  });

  it("rascunho sem stake espera a edição sem chamar a IA; sem o porteiro, a IA lê", async () => {
    const draft = TIP.replace("Stake: 1u", "Stake:");
    expect(await read(draft)).toEqual({ kind: "draft", missing: ["stake"], byRule: true });
    expect(extract.extractBetFromText).not.toHaveBeenCalled();
    extract.extractBetFromText.mockResolvedValue({ bet: bet(), provider: "groq" });
    expect(await read(draft, channel({ draft: false }))).toMatchObject({ kind: "bets", via: "groq" });
  });

  it("na captura pedida pelo dono, o número que o post não escreve entra como 0 para o guard perguntar", async () => {
    const withoutStake = TIP.replace("\nStake: 1u", "");
    expect(await read(withoutStake, { ...channel({ draft: false }), askMissingNumbers: true }))
      .toMatchObject({ kind: "bets", via: "universal", bet: { odds: 2.1, stake: 0 } });
    expect(extract.extractBetFromText).not.toHaveBeenCalled();
    // A stake escrita que a regra não lê continua indo à IA.
    extract.extractBetFromText.mockResolvedValue({ bet: bet(), provider: "groq" });
    expect(await read(TIP.replace("Stake: 1u", "Stake: 3/10"), { ...channel({ draft: false }), askMissingNumbers: true }))
      .toMatchObject({ kind: "bets", via: "groq" });
  });
});

describe("stake ou odd escrita que a regra não lê não fica presa como rascunho", () => {
  const MATCH = "Flamengo x Palmeiras";

  it.each([
    `${MATCH}\nOver 2.5 @1.90\n2%`,
    `${MATCH}\nOver 2.5 @1.90\nStake 3/10`,
    `${MATCH}\nOver 2.5 @1.90\n💰 1.5`,
    `${MATCH}\nOver 2.5 (1.90)\n1u`,
    `🔴 AO VIVO\n${MATCH}\nAmbas marcam 1.85\n1u`,
    `🟢 ENTRADA CONFIRMADA\n${MATCH}\nAmbas marcam 1.85\n1u`,
    `${MATCH}\nAmbas marcam 1.85\n💰 2`,
    `${MATCH}\nAmbas marcam 1.85\n💰 1.5`,
    `${MATCH}\nAmbas marcam 1.85\n1.5`,
    `${MATCH}\nOver 2.5 @1.90 (se possível 1.95+) 2u`,
    `${MATCH}\nOver 2.5 @1.90\nPotencial de green alto, 2u`,
  ])("%j vai à IA", async (text) => {
    extract.extractBetFromText.mockResolvedValue({ bet: bet(), provider: "groq" });
    expect(await read(text)).toMatchObject({ kind: "bets", via: "groq" });
    expect(extract.extractBetFromText).toHaveBeenCalledTimes(1);
  });

  it.each([["Stake 1", 1], ["Stake 2%", 2], ["2 units", 2], ["1 unid", 1]] as const)("'%s' a regra lê sem IA", async (line, stake) => {
    expect(await read(`${MATCH}\nOver 2.5 @1.90\n${line}`)).toMatchObject({ kind: "bets", via: "universal", bet: { stake } });
    expect(extract.extractBetFromText).not.toHaveBeenCalled();
  });
});

describe("leitura pela regra", () => {
  it("a regra lê sem IA, e vale a configuração presa ao post", async () => {
    const withoutStake = TIP.replace("Stake: 1u", "");
    // A banca agora lê a stake do post; quando o post chegou, a stake era fixa.
    const reading = await read(
      withoutStake,
      { ...channel(), stakeSettings: { stakePolicy: "ALWAYS", defaultStakeUnits: 2 } },
      { stakeSettings: { stakePolicy: "MESSAGE", defaultStakeUnits: null } },
    );
    expect(reading).toMatchObject({ kind: "bets", via: "universal", bet: { selecao: "Casa", stake: 2 } });
    expect(extract.extractBetFromText).not.toHaveBeenCalled();
  });
});

describe("o desfecho da IA", () => {
  const readUnread = async (extracted: unknown) => {
    extract.extractBetFromText.mockResolvedValue(extracted);
    return read(UNREAD);
  };

  it("apostas lidas, com quem leu", async () => {
    const bets = [bet(), bet({ evento: "Alcaraz vs Draper", selecao: "Alcaraz -3.5" })];
    expect(await readUnread({ bet: bets[0], bets, provider: "gemini" })).toEqual({ kind: "bets", bet: bets[0], bets, via: "gemini" });
  });

  it("dúvida da leitura vira recusa com a dúvida; na grade sem marca, com a aposta e as opções", async () => {
    const review = { reason: "ambiguous_bet", description: "Não diz o mercado.", evidence: {} };
    expect(await readUnread({ bet: null, provider: null, incompleteDraft: true, missing: ["ambiguous_bet"], review }))
      .toEqual({ kind: "refused", reason: "ambiguous_bet", via: "ia", detail: "Não diz o mercado." });
    const options = [{ selecao: "Sinner +22.5", odds: 1.9 }, { selecao: "Fritz -22.5", odds: 1.9 }];
    const grid = { reason: "unmarked_selection", description: "Duas opções.", evidence: {} };
    expect(await readUnread({ bet: null, provider: "gemini", incompleteDraft: true, missing: ["unmarked_selection"], review: grid, gridChoice: { bet: bet(), options } }))
      .toEqual({ kind: "refused", reason: "unmarked_selection", via: "gemini", detail: "Duas opções.", bet: bet(), options });
  });

  it("rascunho da IA guarda a revisão; só a odd mínima vira aposta sem odd", async () => {
    const review = { reason: "incomplete_extraction", description: "Faltou o confronto.", evidence: {} };
    expect(await readUnread({ bet: null, provider: null, incompleteDraft: true, missing: ["incomplete_extraction"], review }))
      .toEqual({ kind: "draft", missing: ["incomplete_extraction"], byRule: false, review });
    expect(await readUnread({ bet: null, provider: "gemini", incompleteDraft: true, missing: ["stake"] }))
      .toEqual({ kind: "draft", missing: ["stake"], byRule: false });
    const withoutOdds = [bet({ odds: 0 })];
    expect(await readUnread({ bet: null, provider: "gemini", incompleteDraft: true, missing: ["odds"], withoutOdds }))
      .toEqual({ kind: "bets", bet: withoutOdds[0], bets: withoutOdds, via: "gemini", oddsMissing: true });
  });

  it("recusa, não é aposta e provedor fora dizem o que a regra não achou", async () => {
    expect(await readUnread({ bet: null, provider: null, refused: { reason: "leitura_recusada_pela_ia", provider: null } }))
      .toEqual({ kind: "refused", reason: "leitura_recusada_pela_ia", via: "ia" });
    expect(await readUnread({ bet: null, provider: null, refused: { reason: "leitura_nao_mapeada", provider: "mistral" } }))
      .toEqual({ kind: "refused", reason: "leitura_nao_mapeada", via: "mistral" });
    expect(await readUnread({ bet: null, provider: "gemini", notBet: true })).toEqual({ kind: "not_bet", missing: ["mercado"] });
    expect(await readUnread({ bet: null, provider: null, refusalWhenExhausted: { reason: "leitura_recusada_com_provedor_fora" } }))
      .toEqual({ kind: "unavailable", missing: ["mercado"], refusalWhenExhausted: { reason: "leitura_recusada_com_provedor_fora" } });
  });
});

describe("foto", () => {
  const images = new Map<string, CaptureImage>([["f1", { base64: "um", mimeType: "image/jpeg" }], ["f2", { base64: "dois", mimeType: "image/jpeg" }]]);
  const loadImage = vi.fn(async (fileId: string) => images.get(fileId)!);
  const photo = (caption: string, albumFileIds?: string[]) => ({ kind: "photo" as const, caption, fileId: "f1", loadImage, ...(albumFileIds ? { albumFileIds } : {}) });

  beforeEach(() => loadImage.mockClear());

  it("a foto não passa pelo filtro anti-ruído: a legenda sem cara de aposta ainda vai à leitura", async () => {
    extract.extractBetFromImage.mockResolvedValue({ bet: bet(), provider: "gemini" });
    expect(await readBetPost(photo("Bom dia família! 🌞"), channel())).toMatchObject({ kind: "bets", via: "gemini-vision" });
    expect(loadImage).toHaveBeenCalledWith("f1");
  });

  it("legenda de rascunho ou de recapitulação não baixa a imagem", async () => {
    expect(await readBetPost(photo(TIP.replace("Stake: 1u", "Stake:")), channel())).toEqual({ kind: "draft", missing: ["stake"], byRule: true });
    expect(await readBetPost(photo(`${TIP}\n✅ GREEN`), channel())).toEqual({ kind: "skipped", reason: "resultado_ou_balanco" });
    expect(loadImage).not.toHaveBeenCalled();
  });

  it("lê pela imagem e guarda as páginas do post para as releituras", async () => {
    extract.extractBetFromImage.mockResolvedValue({ bet: bet(), provider: "gemini" });
    const reading = await readBetPost(photo("1u", ["f1", "f2"]), channel());
    expect(reading).toMatchObject({ kind: "bets", via: "gemini-vision" });
    expect(extract.extractBetFromImage).toHaveBeenCalledWith(images.get("f1"), "1u", NOW, undefined, undefined);
    if (reading.kind !== "bets") throw new Error("leitura sem aposta");
    expect(loadImage.mock.calls).toEqual([["f1"]]);
    // A irmã só é baixada quando uma releitura pede as páginas.
    expect(await reading.pages?.()).toEqual([images.get("f1"), images.get("f2")]);
    expect(loadImage.mock.calls).toEqual([["f1"], ["f2"]]);
  });

  it("banca que lê a stake da imagem lê o álbum inteiro de uma vez", async () => {
    extract.extractBetsFromImages.mockResolvedValue({ bet: bet(), bets: [bet()], provider: "gemini" });
    const reading = await readBetPost(photo("", ["f1", "f2"]), { ...channel(), stakeSettings: { imageStakeAsUnits: true } });
    expect(reading).toMatchObject({ kind: "bets", via: "gemini-vision", albumFileIds: ["f1", "f2"] });
    expect(extract.extractBetFromImage).not.toHaveBeenCalled();
    if (reading.kind !== "bets") throw new Error("leitura sem aposta");
    expect(await reading.pages?.()).toEqual([{ ...images.get("f1"), fileId: "f1" }, { ...images.get("f2"), fileId: "f2" }]);
  });

  it("imagem que a IA não lê: o que faltou é a imagem", async () => {
    extract.extractBetFromImage.mockResolvedValue({ bet: null, provider: "gemini", notBet: true });
    expect(await readBetPost(photo("olha isso"), channel())).toEqual({ kind: "not_bet", missing: ["imagem"] });
  });
});


it("freebet comprovada vira recusa para conferência, sem rascunho numérico", async () => {
  extract.extractBetFromImage.mockResolvedValue({ bet: null, provider: null, incompleteDraft: true,
    missing: ["unsupported_promotion_terms"], review: { reason: "unsupported_promotion_terms", description: "Freebet utilizada", evidence: {} } });
  expect(await readBetPost({ kind: "photo", caption: "1u", fileId: "photo", loadImage: async () => ({ base64: "fixture", mimeType: "image/jpeg" }) }, channel()))
    .toMatchObject({ kind: "refused", reason: "unsupported_promotion_terms", detail: "Freebet utilizada" });
});

it("lay comprovado vai à conferência sem pedir apenas odd ou stake", async () => {
  extract.extractBetFromImage.mockResolvedValue({ bet: null, provider: null, incompleteDraft: true,
    missing: ["unsupported_trading_terms"], review: { reason: "unsupported_trading_terms", description: "Lay usado: responsabilidade 3u", evidence: {} } });
  expect(await readBetPost({ kind: "photo", caption: "1u", fileId: "photo", loadImage: async () => ({ base64: "fixture", mimeType: "image/jpeg" }) }, channel()))
    .toMatchObject({ kind: "refused", reason: "unsupported_trading_terms", detail: "Lay usado: responsabilidade 3u" });
});
