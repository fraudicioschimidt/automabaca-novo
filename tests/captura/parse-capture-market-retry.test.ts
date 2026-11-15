import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedBetPost } from "@/src/domain/bet-capture";
import { CapturePolicy } from "@/src/generated/prisma/enums";

// Só o resolvedor é sintético: cada teste diz o que ele decide.
vi.mock(import("@/src/services/bets/sport-resolution/capture"), async (original) => ({
  ...await original(),
  resolveSportForCaptureAsync: vi.fn(),
}));
import { resolveSportForCaptureAsync } from "@/src/services/bets/sport-resolution/capture";
import { confirmedSportDecision, unresolvedSportDecision } from "@/src/domain/sports/detect";

vi.mock("@/src/infra/llm/cascade", () => ({
  llmGenerateJson: vi.fn(),
}));
import { llmGenerateJson } from "@/src/infra/llm/cascade";
import { SPORT_RESOLVER_VERSION } from "@/src/domain/sports/detect";
import {
  needsSoccerTotalMarketRetry,
  retryAmbiguousSoccerTotalMarket,
} from "@/src/services/capture/preparation/parse-capture-market-retry";
import { prepareBetForCapture } from "@/src/services/capture/preparation/prepare-capture";

const image = { base64: "abc", mimeType: "image/jpeg" };
const images = async () => [image];
const bet: ParsedBetPost = {
  evento: "Athletic Club vs Operario Ferroviario",
  esporte: "Soccer",
  competicao: "Serie B",
  pais: "Brazil",
  mercado: "Total – Match",
  selecao: "Under 5.5",
  odds: 1.67,
  stake: 1,
  data: null,
  casaDeAposta: "",
};

beforeEach(() => {
  vi.mocked(llmGenerateJson).mockReset();
  // Como o resolvedor faz sem outra evidência: fica com a decisão que a leitura trouxe.
  vi.mocked(resolveSportForCaptureAsync).mockReset().mockImplementation(async ({ bet: read }) => read.sportResolution ?? unresolvedSportDecision());
});

describe("releitura de mercado total em imagem", () => {
  it("detecta total alto de futebol sem qualificador", () => {
    expect(needsSoccerTotalMarketRetry(bet)).toBe(true);
    expect(needsSoccerTotalMarketRetry({ ...bet, selecao: "Under 2.5" })).toBe(false);
    expect(
      needsSoccerTotalMarketRetry(
        { ...bet, selecao: "Under 2.5" },
        { hasImage: true },
      ),
    ).toBe(true);
    expect(
      needsSoccerTotalMarketRetry({ ...bet, mercado: "Total (Bookings) – Match" }),
    ).toBe(false);
    expect(needsSoccerTotalMarketRetry({ ...bet, selecao: "Under 5.5 gols" })).toBe(false);
    expect(needsSoccerTotalMarketRetry({ ...bet, selecao: "Under 21.5 remates" })).toBe(false);
  });

  it.each([
    ["Total", "Over 22.5 games"],
    ["Total Points", "Over 45.5"],
    ["Total de pontos", "Over 45.5"],
    ["Total", "Over 26.5 kills"],
  ])("unidade que o futebol não tem não é total ambíguo: %s / %s", (mercado, selecao) => {
    const unknown = { ...bet, esporte: "Unknown", mercado, selecao };
    expect(needsSoccerTotalMarketRetry(unknown)).toBe(false);
    expect(needsSoccerTotalMarketRetry(unknown, { hasImage: true })).toBe(false);
  });

  it("período antes da linha ('1T Over 110.5') não faz a linha parecer de futebol", () => {
    const unknown = { ...bet, esporte: "Unknown", mercado: "Total", selecao: "1T Over 110.5" };
    expect(needsSoccerTotalMarketRetry(unknown, { hasImage: true })).toBe(false);
    expect(needsSoccerTotalMarketRetry({ ...unknown, selecao: "1T Over 1.5" }, { hasImage: true })).toBe(true);
  });

  it("relê total genérico baixo quando existe imagem", async () => {
    vi.mocked(llmGenerateJson).mockResolvedValueOnce({
      data: { categoria: "cards" },
      provider: "gemini",
    });
    const result = await retryAmbiguousSoccerTotalMarket({
      bet: { ...bet, selecao: "Under 3.5" },
      images,
    });
    expect(result?.mercado).toBe("Total (Bookings) – Match");
  });

  it("corrige total genérico para cartões", async () => {
    vi.mocked(llmGenerateJson).mockResolvedValueOnce({
      data: { categoria: "cards" },
      provider: "gemini",
    });
    const result = await retryAmbiguousSoccerTotalMarket({ bet, images });
    expect(result?.mercado).toBe("Total (Bookings) – Match");
  });

  it("mantém total de gols quando confirmado", async () => {
    vi.mocked(llmGenerateJson).mockResolvedValueOnce({
      data: { categoria: "goals" },
      provider: "gemini",
    });
    await expect(retryAmbiguousSoccerTotalMarket({ bet, images })).resolves.toEqual(bet);
  });

  it("corrige remates totais do jogo sem inventar gols", async () => {
    vi.mocked(llmGenerateJson).mockResolvedValueOnce({
      data: { categoria: "shots" },
      provider: "gemini",
    });
    await expect(retryAmbiguousSoccerTotalMarket({ bet, images })).resolves.toMatchObject({
      mercado: "Total (Shots) – Match",
    });
  });

  it("preserva o time quando a imagem confirma remates por equipe", async () => {
    vi.mocked(llmGenerateJson).mockResolvedValueOnce({
      data: { categoria: "shots" },
      provider: "gemini",
    });
    const result = await retryAmbiguousSoccerTotalMarket({
      bet: {
        ...bet,
        evento: "Santos vs Macara",
        selecao: "Santos - Menos de 21.5",
      },
      images,
    });
    expect(result).toMatchObject({
      mercado: "Team Total (Shots) – Match",
      selecao: "Santos - Menos de 21.5",
    });
  });

  it.each([
    [{ categoria: "goals", periodo: "1st_half" }, "Total – 1st Half"],
    [{ categoria: "goals", periodo: "2nd_half" }, "Total – 2nd Half"],
    [{ categoria: "corners", periodo: "1st_half" }, "Total (Corners) – 1st Half"],
  ])("a linha de um tempo volta com o período certo: %o", async (data, mercado) => {
    vi.mocked(llmGenerateJson).mockResolvedValueOnce({ data, provider: "gemini" });
    await expect(retryAmbiguousSoccerTotalMarket({ bet, images })).resolves.toMatchObject({ mercado, selecao: "Under 5.5" });
  });

  it("total de um tempo sem mercado no catálogo, ou que contradiz o período escrito, continua recusado", async () => {
    vi.mocked(llmGenerateJson).mockResolvedValueOnce({ data: { categoria: "cards", periodo: "1st_half" }, provider: "gemini" });
    await expect(retryAmbiguousSoccerTotalMarket({ bet, images })).resolves.toBeNull();
    vi.mocked(llmGenerateJson).mockResolvedValueOnce({ data: { categoria: "goals", periodo: "1st_half" }, provider: "gemini" });
    await expect(retryAmbiguousSoccerTotalMarket({ bet: { ...bet, selecao: "Athletic Club Under 5.5" }, images })).resolves.toBeNull();
    vi.mocked(llmGenerateJson).mockResolvedValueOnce({ data: { categoria: "goals", periodo: "match" }, provider: "gemini" });
    await expect(retryAmbiguousSoccerTotalMarket({ bet: { ...bet, mercado: "Total – 1st Half" }, images })).resolves.toBeNull();
  });

  it("unknown rejeita a releitura em vez de forçar uma categoria", async () => {
    vi.mocked(llmGenerateJson).mockResolvedValueOnce({
      data: { categoria: "unknown" },
      provider: "gemini",
    });
    await expect(retryAmbiguousSoccerTotalMarket({ bet, images })).resolves.toBeNull();
  });

  it("preserva Team Total quando a seleção de gols nomeia um time do evento", async () => {
    vi.mocked(llmGenerateJson).mockResolvedValueOnce({
      data: { categoria: "goals" },
      provider: "gemini",
    });
    const result = await prepareBetForCapture({
      bet: {
        ...bet,
        evento: "Flamengo vs Vitória",
        selecao: "Flamengo - Mais de 2.5",
        odds: 1.72,
      },
      caption: "",
      capturePolicy: CapturePolicy.AUTO,
      images,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bet).toMatchObject({
      mercado: "Team Total",
      selecao: "Flamengo - Mais de 2.5",
    });
  });

  it("falha fechado quando a categoria não é confirmada", async () => {
    vi.mocked(llmGenerateJson).mockResolvedValueOnce(null);
    await expect(retryAmbiguousSoccerTotalMarket({ bet, images })).resolves.toBeNull();
  });

  it("falha fechado sem imagem quando o total alto não informa a família", async () => {
    await expect(
      prepareBetForCapture({
        bet,
        caption: "Entrada: Under 5.5",
        capturePolicy: CapturePolicy.AUTO,
      }),
    ).resolves.toEqual({
      ok: false,
      missing: ["mercado"],
      reason: "mercado_total_ambiguo",
    });
  });

  describe("total sem unidade a partir da linha 8: escanteios", () => {
    const soccer = confirmedSportDecision("Soccer", "CHANNEL", 90, []);
    const text = (selecao: string, over: Partial<ParsedBetPost> = {}) => ({
      bet: { ...bet, esporte: "Unknown", evento: "Brackley Town vs Scarborough Athletic", selecao, ...over },
      caption: `Brackley x Scarborough ${selecao}`,
      capturePolicy: CapturePolicy.AUTO,
      channelSports: ["Soccer"],
    });

    it.each(["Over 8.5", "Under 11", "Under 10.5", "Over 8"])("%s no futebol confirmado vira escanteios do jogo", async (selecao) => {
      vi.mocked(resolveSportForCaptureAsync).mockResolvedValue(soccer);
      const result = await prepareBetForCapture(text(selecao));
      expect(result).toMatchObject({
        ok: true,
        bet: { mercado: "Total (Corners) – Match", selecao, esporte: "Soccer", totalUnitFromLine: true },
      });
    });

    it("abaixo de 8 a unidade continua sendo perguntada ao dono", async () => {
      vi.mocked(resolveSportForCaptureAsync).mockResolvedValue(soccer);
      await expect(prepareBetForCapture(text("Over 7.5"))).resolves.toMatchObject({ ok: false, reason: "mercado_total_ambiguo" });
      await expect(prepareBetForCapture(text("Under 5.5"))).resolves.toMatchObject({ ok: false, reason: "mercado_total_ambiguo" });
    });

    it("sem futebol confirmado a linha não decide: 8.5 de beisebol são corridas", async () => {
      vi.mocked(resolveSportForCaptureAsync).mockResolvedValue(unresolvedSportDecision());
      await expect(prepareBetForCapture(text("Over 8.5"))).resolves.toMatchObject({ ok: false, reason: "mercado_total_ambiguo" });
      // Beisebol confirmado não é total ambíguo: fica com as corridas do jogo.
      vi.mocked(resolveSportForCaptureAsync).mockResolvedValue(confirmedSportDecision("Baseball", "TEXT", 95, []));
      const baseball = await prepareBetForCapture(text("Over 8.5"));
      expect(baseball).toMatchObject({ ok: true, bet: { esporte: "Baseball", mercado: "Total – Match" } });
      expect(baseball.ok && baseball.bet.totalUnitFromLine).toBeFalsy();
    });

    it.each([
      ["Brackley Town Over 8.5", "Total – Match"],
      ["Brackley Over 8.5", "Total – Match"],
      ["Over 8.5 Scarborough", "Total – Match"],
      ["Over 8.5", "Total – 1st Half"],
      ["1T Over 8.5", "Total – Match"],
      ["Over 8.5 (2º tempo)", "Total – Match"],
    ])("total de um time ou de um tempo não é deduzido: %s / %s", async (selecao, mercado) => {
      vi.mocked(resolveSportForCaptureAsync).mockResolvedValue(soccer);
      await expect(prepareBetForCapture(text(selecao, { mercado }))).resolves.toMatchObject({ ok: false, reason: "mercado_total_ambiguo" });
    });

    it("com print, só a releitura decide: o \"não sei\" dela pode ser chute no alvo", async () => {
      vi.mocked(resolveSportForCaptureAsync).mockResolvedValue(soccer);
      vi.mocked(llmGenerateJson).mockResolvedValueOnce({ data: { categoria: "cards", periodo: "match" }, provider: "gemini" });
      await expect(prepareBetForCapture({ ...text("Over 8.5"), images })).resolves.toMatchObject({
        ok: true, bet: { mercado: "Total (Bookings) – Match" },
      });
      vi.mocked(llmGenerateJson).mockResolvedValueOnce({ data: { categoria: "unknown", periodo: "match" }, provider: "gemini" });
      await expect(prepareBetForCapture({ ...text("Over 8.5"), images })).resolves.toMatchObject({ ok: false, reason: "mercado_total_ambiguo" });
    });

    it("post com print que volta pelo conserto da DM, sem reler, também não deduz", async () => {
      vi.mocked(resolveSportForCaptureAsync).mockResolvedValue(soccer);
      await expect(prepareBetForCapture({ ...text("Over 8.5"), postHasImage: true }))
        .resolves.toMatchObject({ ok: false, reason: "mercado_total_ambiguo" });
    });
  });

  it("aceita texto-only quando a seleção declara gols", async () => {
    await expect(
      prepareBetForCapture({
        bet: { ...bet, selecao: "Under 5.5 gols" },
        caption: "Entrada: Under 5.5 gols",
        capturePolicy: CapturePolicy.AUTO,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("AH split sem time: retry do círculo preenche o lado", async () => {
    vi.mocked(llmGenerateJson).mockResolvedValueOnce({
      data: { selecao: "Plaza Colonia 0.0, -0.5" },
      provider: "gemini",
    });
    const result = await prepareBetForCapture({
      bet: {
        ...bet,
        evento: "Plaza Colonia vs Miramar Misiones",
        mercado: "Asian Handicap",
        selecao: "0.0, -0.5",
        odds: 1.9,
      },
      caption: "Luis / SL\n1u\nmin 1,85",
      capturePolicy: CapturePolicy.AUTO,
      images,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bet.selecao).toBe("Plaza Colonia -0.25");
  });

  it("releituras do guard usam cache de leitura, prazo e a referência do post", async () => {
    vi.mocked(llmGenerateJson)
      .mockResolvedValueOnce({ data: { selecao: "Plaza Colonia 0.0, -0.5" }, provider: "gemini" })
      .mockResolvedValueOnce({ data: { categoria: "cards" }, provider: "gemini" });
    const itemRef = { chatIdHash: "hash-do-canal", messageId: 77 };
    const startedAt = Date.now();
    await prepareBetForCapture({
      bet: { ...bet, evento: "Plaza Colonia vs Miramar Misiones", mercado: "Asian Handicap", selecao: "0.0, -0.5", odds: 1.9 },
      caption: "1u", capturePolicy: CapturePolicy.AUTO, images, itemRef,
    });
    await prepareBetForCapture({ bet, caption: "", capturePolicy: CapturePolicy.AUTO, images, itemRef });
    const calls = vi.mocked(llmGenerateJson).mock.calls.map(([params]) => params);
    expect(calls.map((params) => params.contractVersion)).toEqual(["capture-handicap-side-v3", "capture-market-category-v4"]);
    for (const params of calls) {
      expect(params.itemRef).toEqual(itemRef);
      expect(params.deadlineAt).toBeGreaterThanOrEqual(startedAt + 60_000);
      expect(params.deadlineAt).toBeLessThan(startedAt + 120_000);
    }
    // Só leitura utilizável entra no cache; resposta fora do contrato não.
    expect(calls[0]?.contentState?.({ selecao: "Plaza Colonia 0.0, -0.5" })).toBe("complete");
    expect(calls[0]?.contentState?.({ selecao: "" })).toBe("invalid");
    expect(calls[1]?.contentState?.({ categoria: "cards" })).toBe("complete");
    expect(calls[1]?.contentState?.({ categoria: "handebol" })).toBe("invalid");
  });

  it("releitura olha todas as páginas do post e só as baixa quando precisa", async () => {
    const pages = [image, { base64: "def", mimeType: "image/png" }];
    const load = vi.fn(async () => pages);
    await prepareBetForCapture({ bet: { ...bet, mercado: "Money Line – Match", selecao: "Athletic Club" }, caption: "1u", capturePolicy: CapturePolicy.AUTO, images: load });
    expect(load).not.toHaveBeenCalled();

    vi.mocked(llmGenerateJson)
      .mockResolvedValueOnce({ data: { selecao: "Plaza Colonia 0.0, -0.5" }, provider: "gemini" })
      .mockResolvedValueOnce({ data: { categoria: "cards" }, provider: "gemini" });
    await prepareBetForCapture({
      bet: { ...bet, evento: "Plaza Colonia vs Miramar Misiones", mercado: "Asian Handicap", selecao: "0.0, -0.5", odds: 1.9 },
      caption: "1u", capturePolicy: CapturePolicy.AUTO, images: load,
    });
    const parts = vi.mocked(llmGenerateJson).mock.calls[0]?.[0].parts ?? [];
    expect(parts.filter((part) => "inlineData" in part)).toEqual([
      { inlineData: { mimeType: "image/jpeg", data: "abc" } },
      { inlineData: { mimeType: "image/png", data: "def" } },
    ]);
    expect(parts[0]).toMatchObject({ text: expect.stringContaining("2 imagens") });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("AH split sem time e sem imagem → rejeita lado", async () => {
    await expect(
      prepareBetForCapture({
        bet: {
          ...bet,
          evento: "Yanbian Longding vs Nanjing City",
          mercado: "Handicap – Match",
          selecao: "0.0, -0.5",
          odds: 1.8,
        },
        caption: "Luis / SL\n1u",
        capturePolicy: CapturePolicy.AUTO,
      }),
    ).resolves.toEqual({
      ok: false,
      missing: ["selecao"],
      reason: "lado_handicap_ausente",
    });
  });

  it("converte DNB para o handicap Pinnacle do esporte com linha zero", async () => {
    const result = await prepareBetForCapture({
      bet: {
        ...bet,
        evento: "Flamengo vs Palmeiras",
        mercado: "Draw No Bet",
        selecao: "Flamengo",
      },
      caption: "⚽ Futebol\nFlamengo DNB @1.90 · 1u",
      capturePolicy: CapturePolicy.AUTO,
    });

    expect(result).toMatchObject({
      ok: true,
      bet: { mercado: "Handicap – Match", selecao: "Flamengo 0" },
    });
  });
});

describe('props de jogador e total de handebol não viram total da partida de futebol', () => {
  it.each([
    ['Total de Desarmes', 'tackles_total'],
    ['Total de Desarmes Ganhos', 'tackles_won'],
    ['Total de Passes Completos', 'passes_completed'],
    ['Total de Faltas Cometidas', 'fouls_committed'],
    ['Total de Interceptações', 'interceptions'],
  ])('preserva %s com contrato individual e esporte pendente', async (mercado) => {
    const prop = { ...bet, esporte: 'Unknown', mercado, selecao: 'Michal Skoras Over 1.5',
      playerProp: { jogador: 'Michal Skoras', mercadoOriginal: mercado, selecaoOriginal: '2+' } };
    expect(needsSoccerTotalMarketRetry(prop, { hasImage: true })).toBe(false);
    expect(await prepareBetForCapture({ bet: prop, caption: '1.75u', capturePolicy: CapturePolicy.AUTO, images })).toMatchObject({ ok: true, bet: { mercado, playerProp: prop.playerProp } });
    expect(llmGenerateJson).not.toHaveBeenCalled();
  });

  it.each(['Player Shots', 'Player Tackles', 'Player Cards', 'Player Yellow Cards', 'Player Passes Completed', 'Player Fouls Suffered', 'Player Interceptions', 'Player Saves'])('não converte %s em total da partida', async (mercado) => {
    expect(await prepareBetForCapture({ bet: { ...bet, mercado, selecao: 'Michal Skoras Over 1.5' }, caption: '⚽ 1u', capturePolicy: CapturePolicy.AUTO, images })).toMatchObject({ ok: true, bet: { mercado } });
    expect(llmGenerateJson).not.toHaveBeenCalled();
  });

  it('captura o total de handebol com emoji e nome de competição compartilhado', async () => {
    const caption = '🤾 Europe - Champions League\nMT Melsungen vs HC Vardar 1961\nGolos (62.5) (Odds Justas)\nStake: 2.00u\nAposta: Menos 62.5 @ 1.880';
    expect(await prepareBetForCapture({ bet: { ...bet, esporte: 'Unknown', evento: 'MT Melsungen vs HC Vardar 1961', mercado: 'Total', selecao: 'Menos 62.5', odds: 1.88, stake: 2 }, caption, capturePolicy: CapturePolicy.AUTO })).toMatchObject({ ok: true, bet: { esporte: 'Handball', sportResolution: { status: 'CONFIRMED' } } });
  });
});

it('reconhece o hóquei do post antes de recusar o total, e essa é a decisão da captura', async () => {
  const hockey = confirmedSportDecision('Hockey', 'EMOJI', 95, []);
  vi.mocked(resolveSportForCaptureAsync).mockResolvedValue(hockey);
  const result = await prepareBetForCapture({ bet: { ...bet, esporte: 'Unknown', pais: 'Suécia', evento: 'Frolunda vs Farjestad', mercado: 'Total', selecao: 'Over 5.5' }, caption: '🏒 Entrada: Over 5.5', capturePolicy: CapturePolicy.AUTO });
  expect(result).toMatchObject({ ok: true, bet: { esporte: 'Hockey', sportResolution: hockey } });
  expect(resolveSportForCaptureAsync).toHaveBeenCalledTimes(1);
  // O guard já canonizou o país, que desempata homônimos.
  expect(resolveSportForCaptureAsync).toHaveBeenCalledWith(expect.objectContaining({ bet: expect.objectContaining({ pais: 'Sweden' }) }));
});
it('total de 50 ou mais com esporte desconhecido não é total de futebol', async () => {
  vi.mocked(resolveSportForCaptureAsync).mockResolvedValue(unresolvedSportDecision());
  const result = await prepareBetForCapture({ bet: { ...bet, esporte: 'Unknown', evento: 'Lakers vs Celtics', mercado: 'Total', selecao: 'Over 150.5' }, caption: 'Over 150.5', capturePolicy: CapturePolicy.AUTO });
  expect(result).toMatchObject({ ok: true, bet: { selecao: 'Over 150.5' } });
  expect(needsSoccerTotalMarketRetry({ ...bet, esporte: 'Unknown', mercado: 'Total', selecao: 'Over 49.5' })).toBe(true);
});
it('canal marcado sem futebol não recusa total sem unidade', async () => {
  vi.mocked(resolveSportForCaptureAsync).mockResolvedValue(unresolvedSportDecision());
  const guarded = { ...bet, esporte: 'Unknown', evento: 'Mogi vs Franca', mercado: 'Total', selecao: 'Over 15.5' };
  expect(await prepareBetForCapture({ bet: guarded, caption: 'Over 15.5', capturePolicy: CapturePolicy.AUTO }))
    .toMatchObject({ ok: false, reason: 'mercado_total_ambiguo' });
  expect(await prepareBetForCapture({ bet: guarded, caption: 'Over 15.5', capturePolicy: CapturePolicy.AUTO, channelSports: ['Basketball', 'Volleyball'] }))
    .toMatchObject({ ok: true });
  expect(await prepareBetForCapture({ bet: guarded, caption: 'Over 15.5', capturePolicy: CapturePolicy.AUTO, channelSports: ['Soccer', 'Basketball'] }))
    .toMatchObject({ ok: false, reason: 'mercado_total_ambiguo' });
});
it('continua recusando total sem unidade quando o esporte não pode ser comprovado', async () => {
  expect(await prepareBetForCapture({ bet: { ...bet, esporte: 'Unknown' }, caption: 'Entrada: Under 5.5', capturePolicy: CapturePolicy.AUTO })).toMatchObject({ ok: false, reason: 'mercado_total_ambiguo' });
});

describe('a decisão antecipada só vale confirmada, num esporte em que a linha cabe, e sem releitura depois dela', () => {
  const total: ParsedBetPost = { ...bet, esporte: 'Unknown', evento: 'Time A vs Time B', mercado: 'Total – Match', selecao: 'Mais de 9.5', odds: 1.85 };

  it.each([
    ['pendente', unresolvedSportDecision()],
    ['em conflito', unresolvedSportDecision('CONFLICT')],
    ['confirmada no futebol', confirmedSportDecision('Soccer', 'CHANNEL', 95, [])],
  ])('decisão antecipada %s não vale depois que a releitura acha escanteios', async (_label, early) => {
    vi.mocked(resolveSportForCaptureAsync).mockResolvedValueOnce(early);
    vi.mocked(llmGenerateJson).mockResolvedValueOnce({ data: { categoria: 'corners', periodo: 'match' }, provider: 'gemini' });
    expect(await prepareBetForCapture({ bet: total, caption: 'Mais de 9.5 @1.85', capturePolicy: CapturePolicy.AUTO, images }))
      .toMatchObject({ ok: true, bet: { mercado: 'Total (Corners) – Match', esporte: 'Soccer', sportResolution: { status: 'CONFIRMED', source: 'TEXT' } } });
    // O esporte é decidido de novo sobre o mercado relido.
    expect(resolveSportForCaptureAsync).toHaveBeenCalledTimes(2);
  });

  it('basquete confirmado não libera "Mais de 9.5": o total segue sem unidade', async () => {
    vi.mocked(resolveSportForCaptureAsync).mockResolvedValue(confirmedSportDecision('Basketball', 'EMOJI', 95, []));
    expect(await prepareBetForCapture({ bet: total, caption: '1u', postCaption: '🏀 Time A x Time B\nMais de 9.5 @1.85\n1u', capturePolicy: CapturePolicy.AUTO }))
      .toMatchObject({ ok: false, reason: 'mercado_total_ambiguo' });
  });

  it('o esporte que o dono escolheu libera o total', async () => {
    const owner = confirmedSportDecision('Basketball', 'MANUAL', 100, []);
    // A legenda com ⚽ desmente o dono no guard, e o total chega sem esporte.
    expect(await prepareBetForCapture({ bet: { ...total, esporte: 'Basketball', sportResolution: owner }, caption: '⚽ Mais de 9.5 @1.85 1u', capturePolicy: CapturePolicy.AUTO, ownerSport: owner }))
      .toMatchObject({ ok: true, bet: { esporte: 'Basketball', sportResolution: owner } });
    expect(resolveSportForCaptureAsync).not.toHaveBeenCalled();
  });
});

describe('o esporte da captura é decidido uma vez, na preparação', () => {
  const moneyline: ParsedBetPost = { ...bet, evento: 'Flamengo vs Vasco', esporte: 'Unknown', pais: 'Brasil', mercado: 'Moneyline', selecao: 'Flamengo', odds: 1.9 };
  /** A IA leu futebol, sem confirmar. */
  const soccerRead: ParsedBetPost = {
    ...moneyline, esporte: 'Soccer',
    sportResolution: { sport: 'Soccer', status: 'PENDING', confidence: 60, source: 'LLM', evidence: [], resolverVersion: SPORT_RESOLVER_VERSION },
  };
  it('a decisão lê a legenda do post, com o país já canonizado', async () => {
    await prepareBetForCapture({ bet: moneyline, caption: '1u', postCaption: '⚽ Flamengo x Vasco\nFlamengo @1.90 1u', capturePolicy: CapturePolicy.AUTO, channelSports: ['Soccer'] });
    expect(resolveSportForCaptureAsync).toHaveBeenCalledTimes(1);
    expect(resolveSportForCaptureAsync).toHaveBeenCalledWith({
      bet: expect.objectContaining({ pais: 'Brazil' }), caption: '⚽ Flamengo x Vasco\nFlamengo @1.90 1u', channelSports: ['Soccer'],
    });
  });

  it('o esporte escolhido pelo dono no conserto vale sem passar pelo resolvedor', async () => {
    const owner = confirmedSportDecision('Basketball', 'MANUAL', 100, []);
    expect(await prepareBetForCapture({ bet: moneyline, caption: 'Flamengo @1.90 1u', capturePolicy: CapturePolicy.AUTO, ownerSport: owner }))
      .toMatchObject({ ok: true, bet: { esporte: 'Basketball', sportResolution: owner } });
    expect(resolveSportForCaptureAsync).not.toHaveBeenCalled();
  });

  /** Seleções escritas em português: só o futebol as traduz para o nome da Pinnacle. */
  const nationsRead: ParsedBetPost = { ...soccerRead, evento: 'Espanha vs Itália', selecao: 'Espanha' };

  it('confirmado noutro esporte, os nomes voltam a ser canonizados a partir da aposta do guard', async () => {
    vi.mocked(resolveSportForCaptureAsync).mockResolvedValue(confirmedSportDecision('Basketball', 'CHANNEL', 95, []));
    // A segunda canonização parte dos nomes lidos, não dos já traduzidos para o futebol.
    expect(await prepareBetForCapture({ bet: nationsRead, caption: 'Espanha @1.90 1u', capturePolicy: CapturePolicy.AUTO }))
      .toMatchObject({ ok: true, bet: { evento: 'Espanha vs Itália', esporte: 'Basketball' } });
  });

  it('confirmado no esporte da leitura, ou sem confirmar, a canonização é a do futebol', async () => {
    vi.mocked(resolveSportForCaptureAsync).mockResolvedValue(confirmedSportDecision('Soccer', 'TEXT', 95, []));
    expect(await prepareBetForCapture({ bet: nationsRead, caption: 'Espanha @1.90 1u', capturePolicy: CapturePolicy.AUTO }))
      .toMatchObject({ ok: true, bet: { evento: 'Spain vs Italy', esporte: 'Soccer' } });
    vi.mocked(resolveSportForCaptureAsync).mockResolvedValue(unresolvedSportDecision('CONFLICT'));
    expect(await prepareBetForCapture({ bet: nationsRead, caption: 'Espanha @1.90 1u', capturePolicy: CapturePolicy.AUTO }))
      .toMatchObject({ ok: true, bet: { evento: 'Spain vs Italy', esporte: 'Unknown', sportResolution: { status: 'CONFLICT' } } });
  });
});
