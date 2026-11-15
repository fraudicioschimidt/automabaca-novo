import { describe, expect, it } from "vitest";
import { CapturePolicy } from "@/src/generated/prisma/enums";
import {
  finalizeParsedBetForCapture,
  validateParsedBetBeforeRegister,
} from "@/src/services/capture/preparation/parse-capture-guard";
import type { ParsedBetPost } from "@/src/domain/bet-capture";
import { enrichParsedBetFromCaption } from "@/src/services/capture/preparation/parse-caption-enrich";
import { inferPaisFromCompeticao } from "@/src/services/capture/preparation/parse-caption-enrich";
import { extractCaptionBetHints } from "@/src/services/capture/preparation/parse-caption-hints";
import { llmSportDecision } from "@/src/domain/sports/detect";
import { parseUniversalBetPost } from "@/src/domain/parse-bet-post";
import { resolveCaptureStake } from "@/src/domain/capture-stake-policy";

const base: ParsedBetPost = {
  evento: "Flamengo vs Palmeiras",
  esporte: "Soccer",
  competicao: "",
  pais: "",
  mercado: "Moneyline",
  selecao: "Flamengo",
  odds: 1.85,
  stake: 1,
  data: null,
  casaDeAposta: "",
};

describe("parse-capture-guard", () => {
  it("preserva placar live estruturado vindo da seleção ou só da legenda", () => {
    const fromSelection = finalizeParsedBetForCapture(
      { ...base, mercado: "Asian Handicap", selecao: "(1-0) Palmeiras +0.25" },
      "1u @1.85",
      CapturePolicy.AUTO,
    );
    expect(fromSelection).toMatchObject({
      ok: true,
      bet: { liveScoreHome: 1, liveScoreAway: 0 },
    });

    const fromCaption = finalizeParsedBetForCapture(
      { ...base, mercado: "Asian Handicap", selecao: "Palmeiras +0.25" },
      "(2-0)+0.25\n1u @1.85",
      CapturePolicy.AUTO,
    );
    expect(fromCaption).toMatchObject({
      ok: true,
      bet: { liveScoreHome: 2, liveScoreAway: 0 },
    });
  });

  it("rejeita placares live conflitantes sem escolher uma das fontes", () => {
    const result = finalizeParsedBetForCapture(
      { ...base, mercado: "Asian Handicap", selecao: "(1-0) Palmeiras +0.25" },
      "Entrada: (2-0) Palmeiras +0.25\n1u @1.85",
      CapturePolicy.AUTO,
    );
    expect(result).toEqual({
      ok: false,
      missing: ["placarLive"],
      reason: "conflicting_live_score",
    });
  });

  it("não atribui país errado a ligas ambíguas e cobre ligas explícitas", () => {
    expect(inferPaisFromCompeticao("Serie A")).toBe("");
    expect(inferPaisFromCompeticao("Serie A Italy")).toBe("Italy");
    expect(inferPaisFromCompeticao("Brasileirao Serie A")).toBe("Brazil");
    expect(inferPaisFromCompeticao("Copa Libertadores")).toBe("International");
    expect(inferPaisFromCompeticao("MLS")).toBe("USA");
    expect(inferPaisFromCompeticao("Eredivisie")).toBe("Netherlands");
    expect(inferPaisFromCompeticao("Liga Portugal")).toBe("Portugal");
  });

  it("as Premier League de críquete não são da Inglaterra", () => {
    expect(inferPaisFromCompeticao("Indian Premier League")).toBe("India");
    expect(inferPaisFromCompeticao("Bangladesh Premier League")).toBe("Bangladesh");
    expect(inferPaisFromCompeticao("Lanka Premier League")).toBe("Sri Lanka");
    expect(inferPaisFromCompeticao("Caribbean Premier League")).toBe("");
    expect(inferPaisFromCompeticao("Premier League")).toBe("England");
  });

  it("lê formato brasileiro com milhar antes de aplicar o teto de stake", () => {
    expect(extractCaptionBetHints("stake 1.234,56u @2.10")).toEqual({
      stake: 1234.56,
      odds: 2.1,
    });
  });

  it("aceita @odd fora da linha do stake (CAPTION_ODD); ignora @username", () => {
    expect(extractCaptionBetHints("@123usuario\n1u")).toEqual({ stake: 1 });
    expect(extractCaptionBetHints("Will / SL @2.10\n1u")).toEqual({
      stake: 1,
      odds: 2.1,
    });
    expect(extractCaptionBetHints("Jogo @2.10\n1u")).toEqual({
      stake: 1,
      odds: 2.1,
    });
    expect(extractCaptionBetHints("1u @2.10")).toEqual({ stake: 1, odds: 2.1 });
    expect(extractCaptionBetHints("2 unidades @2.10")).toEqual({ stake: 2, odds: 2.1 });
    expect(extractCaptionBetHints("min: @1,85")).toEqual({});
    expect(extractCaptionBetHints("min = @1,85")).toEqual({});
    expect(extractCaptionBetHints("1u\nmínima 2u")).toEqual({ stake: 1 });
  });

  it("no post misto, a legenda não tira a liga do item que a IA leu como futebol", () => {
    const caption = "Múltipla do dia\n🏀 Lakers x Celtics - Over 220.5\nJuventus x Milan (Serie A) - Over 2.5";
    const juventus = { ...base, evento: "Juventus vs Milan", competicao: "Serie A", mercado: "Total", selecao: "Over 2.5" };
    const lakers = { ...base, evento: "Lakers vs Celtics", competicao: "NBA", mercado: "Total", selecao: "Over 220.5" };
    expect(enrichParsedBetFromCaption({ ...juventus, sportResolution: llmSportDecision({ sport: "Soccer", confidence: 0.9 }) }, caption))
      .toMatchObject({ esporte: "Unknown", sportResolution: { status: "CONFLICT" } });
    // A legenda confirma o item de basquete, e a leitura da IA fica na evidência.
    const enriched = enrichParsedBetFromCaption({ ...lakers, sportResolution: llmSportDecision({ sport: "Basketball", confidence: 0.9 }) }, caption);
    expect(enriched.sportResolution).toMatchObject({ status: "CONFIRMED", sport: "Basketball", source: "EMOJI" });
    expect(enriched.sportResolution?.evidence).toContainEqual(expect.objectContaining({ source: "LLM", sport: "Basketball" }));
  });

  it("enrich genérico não sobrescreve a odd extraída do print", () => {
    const enriched = enrichParsedBetFromCaption(
      { ...base, odds: 1.916 },
      "Luis / SL\n1u\nODD informativa 1.85",
    );
    expect(enriched.odds).toBe(1.916);
  });

  it("preserva a família de cartões escrita depois da linha", () => {
    const enriched = enrichParsedBetFromCaption(
      { ...base, mercado: "Total", selecao: "Under 5.5 cards" },
      [
        "Tipster: Target",
        "Jogo: Independiente Medellin vs. Vasco",
        "Entrada: Under 5.5 cards",
        "ODD: 1.75",
      ].join("\n"),
    );
    expect(enriched.mercado).toBe("Total Cards");
  });

  it("preserva a família de escanteios escrita depois da linha", () => {
    const enriched = enrichParsedBetFromCaption(
      { ...base, mercado: "Total", selecao: "Over 8.5 corners" },
      "Entrada: Over 8.5 corners",
    );
    expect(enriched.mercado).toBe("Corners O/U");
  });

  it("promove total de escanteios do 1º tempo para o label Pinnacle do período", () => {
    const enriched = enrichParsedBetFromCaption(
      { ...base, mercado: "Total", selecao: "Over 4.5 corners 1st half" },
      "Entrada: Over 4.5 corners 1st half",
    );
    expect(enriched.mercado).toBe("Total (Corners) – 1st Half");
  });

  it("não confunde ambas recebem cards com handicap da partida", () => {
    const enriched = enrichParsedBetFromCaption(
      { ...base, mercado: "Asian Handicap", selecao: "Ambas recebem +2 cards" },
      [
        "Tipster: Target",
        "Jogo: Operario vs. Ponte Preta",
        "Entrada: Ambas recebem +2 cards",
        "ODD: 1.78",
      ].join("\n"),
    );
    expect(enriched.mercado).toBe("Both Teams Cards – Match");
  });

  it("reconhece a forma compacta 'Ambas 2+ cartões' observada na captura", () => {
    const enriched = enrichParsedBetFromCaption(
      { ...base, mercado: "Moneyline", selecao: "Ambas 2+ cartões" },
      [
        "Tipster: Target",
        "Jogo: Gremio vs. São Paulo",
        "Entrada: Ambas 2+ cartões",
        "ODD: 1.78",
      ].join("\n"),
    );
    expect(enriched.mercado).toBe("Both Teams Cards – Match");
  });

  it("Will: força odd @ da legenda sobre vision errada", () => {
    const r = finalizeParsedBetForCapture(
      { ...base, odds: 1.85 },
      "Will / SL\n0.50u @1.925",
      CapturePolicy.CAPTION_ODD,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bet.odds).toBe(1.925);
    expect(r.bet.stake).toBe(0.5);
  });

  it("Luis: aceita odd atual igual à mínima informativa", () => {
    const r = finalizeParsedBetForCapture(
      { ...base, odds: 1.85 },
      "Luis / SL\n1u\nmin 1,85",
      CapturePolicy.IMAGE_ODD,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bet.odds).toBe(1.85);
  });

  it("mínima por extenso também não bloqueia a odd atual", () => {
    const r = finalizeParsedBetForCapture(
      { ...base, odds: 1.85 },
      "Luis / SL\n1u\nmínima 1,85",
      CapturePolicy.IMAGE_ODD,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bet.odds).toBe(1.85);
  });

  it("rejeita legenda com múltiplas apostas em vez de escolher a última", () => {
    const r = finalizeParsedBetForCapture(
      base,
      "A vs B 1u @1.85\nC vs D 0.5u @2.10",
      CapturePolicy.AUTO,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("legenda_com_multiplas_apostas");
  });

  it("não expõe stake nem odd arbitrárias quando a legenda é ambígua", () => {
    expect(extractCaptionBetHints("A 1u @2.05\nB 0.5u @1.85")).toEqual({ ambiguous: true });
  });

  it("odd mínima na linha da stake é limite, não uma segunda aposta", () => {
    const caption = "Araujo / SL\n\nSiauliai para vencer @1.95\n\n1u / Até @1.76 https://www.bet365.bet.br/#/IP/EV152016989605C18";
    expect(extractCaptionBetHints(caption)).toEqual({ stake: 1, odds: 1.95 });
    expect(extractCaptionBetHints("0.5u / min @1.80\nOver 2.5 @1.95")).toEqual({ stake: 0.5, odds: 1.95 });
    expect(extractCaptionBetHints("1u @1.95 / máx @2.10")).toEqual({ stake: 1, odds: 1.95 });
  });

  it("recusa handicap sem linha para não impedir CLV e liquidação", () => {
    const r = validateParsedBetBeforeRegister(
      {
        ...base,
        mercado: "Handicap – Match",
        selecao: "Charlotte Independence",
        evento: "Spokane Velocity vs Charlotte Independence",
      },
      "",
      CapturePolicy.AUTO,
    );
    expect(r).toEqual({
      ok: false,
      missing: ["selecao"],
      reason: "linha_handicap_ausente",
    });
  });

  it("aceita AH 0.0 (level ball) com time — não é linha ausente", () => {
    const r = validateParsedBetBeforeRegister(
      {
        ...base,
        mercado: "Handicap – Match",
        selecao: "Lørenskog 0.0",
        evento: "Lørenskog v Honefoss",
        odds: 1.975,
      },
      "Luis / SL\n1u\nmin 1,92",
      CapturePolicy.AUTO,
    );
    expect(r.ok).toBe(true);
  });

  it("recusa AH split sem time (lado do círculo ausente)", () => {
    const r = validateParsedBetBeforeRegister(
      {
        ...base,
        mercado: "Handicap – Match",
        selecao: "0.0, -0.5",
        evento: "Yanbian Longding vs Nanjing City",
      },
      "Luis / SL\n1u\nmin 1,80",
      CapturePolicy.AUTO,
    );
    expect(r).toEqual({
      ok: false,
      missing: ["selecao"],
      reason: "lado_handicap_ausente",
    });
  });

  it("Luis: aceita odd do print diferente do min", () => {
    const r = finalizeParsedBetForCapture(
      { ...base, odds: 1.916 },
      "Luis / SL\n1u\nmin 1,85",
      CapturePolicy.IMAGE_ODD,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bet.odds).toBe(1.916);
    expect(r.bet.stake).toBe(1);
  });

  it("Luis: preserva diferença real na terceira casa da odd", () => {
    const r = finalizeParsedBetForCapture(
      { ...base, odds: 1.925 },
      "Luis / SL\n1u\nmin 1,92",
      CapturePolicy.AUTO,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bet.odds).toBe(1.925);
  });

  it("Uyoz: aceita odd igual ao min", () => {
    const r = finalizeParsedBetForCapture(
      { ...base, odds: 2.6 },
      "uyoz\nUyoZ / SL\n0.5u - min 2.60",
      CapturePolicy.IMAGE_ODD,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bet.odds).toBe(2.6);
  });

  it("CAPTION_ODD: pequena diferença do print, a legenda manda", () => {
    const r = finalizeParsedBetForCapture({ ...base, odds: 2.0 }, "Will / SL\n0.50u @1.925", CapturePolicy.CAPTION_ODD, { readFromImage: true });
    expect(r).toMatchObject({ ok: true, bet: { odds: 1.925 } });
  });

  it("canal genérico sem min: passa com odd do parse", () => {
    const r = finalizeParsedBetForCapture({ ...base, odds: 2.05 }, "slip", CapturePolicy.AUTO);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bet.odds).toBe(2.05);
  });

  it.each([
    ["Both Teams to Score", "Sim e Over 2.5"],
    ["Money Line – Match", "Flamengo e Over 1.5"],
    ["Total – Match", "Ambas marcam e Over 2.5"],
    ["Both Teams to Score", "Sim + Flamengo vence"],
  ])("recusa a combinada lida sem pernas num mercado simples: %s · %s", (mercado, selecao) => {
    expect(finalizeParsedBetForCapture({ ...base, mercado, selecao }, "", CapturePolicy.AUTO))
      .toEqual({ ok: false, missing: ["selecao"], reason: "selecao_combinada" });
  });

  it.each([
    ["Moneyline", "Brighton & Hove", "Brighton & Hove vs Arsenal"],
    ["Both Teams to Score", "Sim", "Flamengo vs Palmeiras"],
    ["Double Chance", "Flamengo e Empate", "Flamengo vs Palmeiras"],
    ["Player Points + Rebounds", "LeBron James pontos e rebotes Over 30.5", "Lakers vs Celtics"],
  ])("não confunde com combinada: %s · %s", (mercado, selecao, evento) => {
    expect(finalizeParsedBetForCapture({ ...base, evento, mercado, selecao }, "", CapturePolicy.AUTO)).toMatchObject({ ok: true });
  });

  it("rejeita evento ausente", () => {
    const r = validateParsedBetBeforeRegister({ ...base, evento: "" }, "slip", CapturePolicy.AUTO);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("evento_ausente");
  });

  it("rejeita stake inválido", () => {
    const r = validateParsedBetBeforeRegister({ ...base, stake: 0 }, "slip", CapturePolicy.AUTO);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("stake_invalido");
  });

  it("rejeita odd inválida", () => {
    const r = validateParsedBetBeforeRegister({ ...base, odds: 0.5 }, "slip", CapturePolicy.AUTO);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("odd_invalida");
  });

  it("CAPTION_ODD: rejeita legenda @ sem odd extraível (>1)", () => {
    const r = validateParsedBetBeforeRegister(base, "Will / SL\n0.50u @1", CapturePolicy.CAPTION_ODD);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("odd_legenda_ausente");
  });

  it("CAPTION_ODD: aceita @odd na linha do tipster e stake na seguinte", () => {
    const r = finalizeParsedBetForCapture(
      { ...base, odds: 2.1 },
      "Will / SL @2.10\n1u",
      CapturePolicy.CAPTION_ODD,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bet.odds).toBe(2.1);
  });

  describe("canal treino (política pela legenda)", () => {
    it("Will repostado com slug treino", () => {
      const r = finalizeParsedBetForCapture(
        { ...base, odds: 1.85 },
        "Will / SL\n0.75u @1.850",
        CapturePolicy.AUTO,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.bet.odds).toBe(1.85);
      expect(r.bet.stake).toBe(0.75);
    });

    it("Luis repostado com slug treino-lab aceita odd igual à mínima", () => {
      const r = finalizeParsedBetForCapture(
        { ...base, odds: 1.85 },
        "Luis / SL\n1u\nmin 1,85",
        CapturePolicy.AUTO,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.bet.odds).toBe(1.85);
    });

    it("Uyoz repostado com slug treino aceita odd igual à mínima", () => {
      const r = finalizeParsedBetForCapture(
        { ...base, odds: 2.6 },
        "uyoz\nUyoZ / SL\n0.5u - min 2.60",
        CapturePolicy.AUTO,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.bet.odds).toBe(2.6);
    });
  });

  describe("odd da legenda contra a do print (decisão do dono: vale a do print)", () => {
    const fromImage = { readFromImage: true };

    it("print 2,10 com legenda '@1.90' grava 2,10", () => {
      const r = finalizeParsedBetForCapture({ ...base, odds: 2.1 }, "Flamengo -0.5 @1.90 1u", CapturePolicy.AUTO, fromImage);
      expect(r).toMatchObject({ ok: true, bet: { odds: 2.1, stake: 1 } });
    });

    it("print 2,10 com legenda '@18.5' é recusa, não troca", () => {
      const r = finalizeParsedBetForCapture({ ...base, odds: 2.1 }, "Flamengo -0.5 @18.5 1u", CapturePolicy.AUTO, fromImage);
      expect(r).toEqual({ ok: false, missing: ["odds"], reason: "odd_diverge_legenda" });
    });

    it("banca IMAGE_ODD também recusa divergência grande", () => {
      const r = finalizeParsedBetForCapture({ ...base, odds: 1.85 }, "1u @2.60", CapturePolicy.IMAGE_ODD, fromImage);
      expect(r).toEqual({ ok: false, missing: ["odds"], reason: "odd_diverge_legenda" });
    });

    it("leitura de texto que diverge muito do '@' do próprio post é recusada, não corrigida", () => {
      const text = "Jogo: Flamengo x Palmeiras\nEntrada: Flamengo ML\n@1.90\n1u";
      const r = finalizeParsedBetForCapture({ ...base, odds: 9.5, stake: 1 }, text, CapturePolicy.AUTO);
      expect(r).toEqual({ ok: false, missing: ["odds"], reason: "odd_diverge_legenda" });
    });

    it("texto com '@' próximo da odd lida: o '@' do post vale", () => {
      const r = finalizeParsedBetForCapture({ ...base, odds: 1.85 }, "Odd: 1.85\nPeguei @1.95\n1u", CapturePolicy.AUTO);
      expect(r).toMatchObject({ ok: true, bet: { odds: 1.95 } });
    });
  });

  describe("teto de odd e de stake da captura automática", () => {
    it("'@185' num mercado de placar simples é odd_implausivel", () => {
      expect(finalizeParsedBetForCapture({ ...base, odds: 185, stake: 5 }, "Flamengo ML\n@185\n5u", CapturePolicy.AUTO))
        .toEqual({ ok: false, missing: ["odds"], reason: "odd_implausivel" });
    });

    it.each([
      ["Correct Score", "2-1"],
      ["Anytime Goalscorer", "Pedro"],
      ["Outright Winner", "Flamengo"],
    ])("%s com odd alta passa", (mercado, selecao) => {
      expect(finalizeParsedBetForCapture({ ...base, mercado, selecao, odds: 25 }, "", CapturePolicy.AUTO)).toMatchObject({ ok: true });
    });

    it.each([
      ["Resultado Intervalo/Final", "Flamengo/Flamengo"],
      ["Total exato de gols", "3"],
      ["Resultado + Ambas marcam", "Flamengo e Sim"],
      ["Resultado Final e Total de Gols", "Flamengo e Over 2.5"],
    ])("mercado combinado ou exato '%s' com odd alta passa", (mercado, selecao) => {
      expect(finalizeParsedBetForCapture({ ...base, mercado, selecao, odds: 25 }, "", CapturePolicy.AUTO)).toMatchObject({ ok: true });
    });

    it("Money Line de azarão acima de 20 continua recusada, salvo quando o dono respondeu a odd", () => {
      const underdog = { ...base, evento: "Sinner vs Zeppieri", selecao: "Zeppieri", odds: 21 };
      expect(finalizeParsedBetForCapture(underdog, "🎾", CapturePolicy.AUTO)).toMatchObject({ ok: false, reason: "odd_implausivel" });
      expect(finalizeParsedBetForCapture(underdog, "🎾", CapturePolicy.AUTO, { oddsFromOwner: true })).toMatchObject({ ok: true });
    });

    it("múltipla com odd alta passa", () => {
      const legs = { kind: "parlay" as const, legs: [
        { evento: "A vs B", mercado: "Moneyline", selecao: "A" },
        { evento: "C vs D", mercado: "Moneyline", selecao: "C" },
      ] };
      expect(finalizeParsedBetForCapture({ ...base, odds: 25, legs }, "", CapturePolicy.AUTO)).toMatchObject({ ok: true });
    });

    // O post rotulado que o leitor por regra lê: o nome do mercado vem literal do rótulo.
    const labeledPost = (evento: string, mercado: string, selecao: string, odd: string) =>
      `Jogo: ${evento}\nMercado: ${mercado}\nEntrada: ${selecao}\nOdd: ${odd}\nStake: 1u`;
    const readAndGuard = (post: string) => {
      const parsed = parseUniversalBetPost(post);
      if (!parsed.ok) throw new Error(`leitura por regra falhou: ${parsed.missing.join(",")}`);
      return finalizeParsedBetForCapture(parsed.bet, post, CapturePolicy.AUTO);
    };

    it.each([
      ["Flamengo x Palmeiras", "Gols", "Over 2.5"],
      ["Flamengo x Palmeiras", "Gols asiáticos", "Over 2.5"],
      ["Flamengo x Palmeiras", "Para vencer", "Flamengo"],
      ["Flamengo x Palmeiras", "HA", "Flamengo -1"],
      ["Flamengo x Palmeiras", "Ambas", "Sim"],
      ["Flamengo x Palmeiras", "Live", "Over 2.5"],
      ["Lakers x Celtics", "Pontos", "Over 210.5"],
      ["Lakers x Celtics", "Pontos", "1T Over 110.5"],
      ["Lakers x Celtics", "Pontos", "1º Quarto Over 54.5"],
      ["Lakers x Celtics", "Pontos", "Q1 Over 54.5"],
      ["Lakers x Celtics", "Pontos", "1Q Over 54.5"],
      ["Flamengo x Palmeiras", "Live", "HT Over 0.5"],
      ["Flamengo x Palmeiras", "Live", "2º Tempo Over 1.5"],
      ["Flamengo x Palmeiras", "Live", "FT Over 2.5"],
      ["Flamengo x Palmeiras", "Ao vivo", "Gols Over 2.5"],
      ["Flamengo x Palmeiras", "Aposta", "Total de gols Over 2.5"],
      ["Flamengo x Palmeiras", "Live", "Flamengo 1T Over 0.5"],
      ["Flamengo x Palmeiras", "Live", "1ºT Over 0.5"],
      ["Flamengo x Palmeiras", "Ao vivo", "2ºT Over 1.5"],
      ["Flamengo x Palmeiras", "Aposta", "1°T - Over 0.5"],
      ["Flamengo x Palmeiras", "Live", "PT Over 0.5"],
      ["Flamengo x Palmeiras", "Live", "ST Over 0.5"],
      ["St Pauli x Hamburg", "Live", "St Pauli Over 1.5"],
    ])("mercado '%s'/'%s' com nome fora do classificador e seleção de placar simples: '@185' é odd_implausivel", (evento, mercado, selecao) => {
      expect(readAndGuard(labeledPost(evento, mercado, selecao, "185")))
        .toEqual({ ok: false, missing: ["odds"], reason: "odd_implausivel" });
    });

    it.each([
      ["Flamengo x Palmeiras", "Método de vitória", "Flamengo por KO"],
      ["Flamengo x Palmeiras", "Handicap Europeu", "Flamengo -2"],
      ["Flamengo x Palmeiras", "Placar", "2-1"],
      ["Flamengo x Palmeiras", "Jogador marca", "Pedro"],
      ["Lakers x Celtics", "Pontos", "LeBron James Over 25.5"],
      ["Lakers x Celtics", "Pontos", "LeBron James 1T Over 12.5"],
      ["Lakers x Celtics", "Pontos", "LeBron James 1ºT Over 12.5"],
    ])("mercado '%s'/'%s' que não é placar simples continua aceitando odd alta", (evento, mercado, selecao) => {
      expect(readAndGuard(labeledPost(evento, mercado, selecao, "25"))).toMatchObject({ ok: true, bet: { odds: 25 } });
    });

    it.each([
      ["Lakers vs Celtics", "Total 1º Quarto", "Over 50.5"],
      ["Sinner vs Alcaraz", "Money Line – 1st Set", "Sinner"],
      ["Sinner vs Alcaraz", "Vencedor 2º set", "Alcaraz"],
      ["Flamengo vs Palmeiras", "Total de gols 0-15 min", "Over 0.5"],
      ["Flamengo vs Palmeiras", "Handicap 2º período", "Flamengo -0.5"],
      ["Flamengo vs Palmeiras", "Especial", "Over 2.5"],
    ])("parte do jogo '%s · %s' com '@185' é odd_implausivel, como no jogo inteiro", (evento, mercado, selecao) => {
      expect(finalizeParsedBetForCapture({ ...base, evento, mercado, selecao, odds: 185 }, "", CapturePolicy.AUTO))
        .toEqual({ ok: false, missing: ["odds"], reason: "odd_implausivel" });
    });

    it.each([
      ["Sinner vs Alcaraz", "Placar exato 1º set", "6-4"],
      ["Flamengo vs Palmeiras", "Primeiro a marcar", "Pedro"],
      ["Flamengo vs Palmeiras", "Especial", "Pedro marca de cabeça"],
    ])("placar exato, artilheiro e especial '%s · %s' seguem aceitando odd alta", (evento, mercado, selecao) => {
      expect(finalizeParsedBetForCapture({ ...base, evento, mercado, selecao, odds: 25 }, "", CapturePolicy.AUTO)).toMatchObject({ ok: true });
    });

    it("stake do post acima de 20u é stake_implausivel; a da banca não", () => {
      expect(finalizeParsedBetForCapture({ ...base, stake: 25 }, "", CapturePolicy.AUTO))
        .toEqual({ ok: false, missing: ["stake"], reason: "stake_implausivel" });
      const fixed = { version: 1 as const, stakePolicy: "ALWAYS" as const, defaultStakeUnits: 25, originalStake: null, source: "bankroll_fixed" as const };
      expect(finalizeParsedBetForCapture({ ...base, stake: 25, stakePolicySnapshot: fixed }, "", CapturePolicy.AUTO)).toMatchObject({ ok: true });
    });
  });

  describe("stake da legenda que não é a da aposta", () => {
    it("'Meta do mês: 30u' não sobrescreve a stake do print", () => {
      const r = finalizeParsedBetForCapture({ ...base, odds: 2.1, stake: 0.5 }, "Flamengo -0.5 @2.10\nMeta do mês: 30u", CapturePolicy.AUTO, { readFromImage: true });
      expect(r).toMatchObject({ ok: true, bet: { stake: 0.5 } });
    });

    it.each(["Meta da semana • 15u", "Meta semanal | 10u", "Lucro do mês • 12u", "Meta / 10u"])(
      "'%s' não é stake da legenda nem sobrescreve a stake do print",
      (line) => {
        const caption = `${line}\nFlamengo x Palmeiras\nEntrada: Over 2.5\n@1.90`;
        expect(extractCaptionBetHints(caption)).toEqual({ odds: 1.9 });
        const r = finalizeParsedBetForCapture({ ...base, mercado: "Total", selecao: "Over 2.5", odds: 1.9, stake: 1 }, caption, CapturePolicy.AUTO, { readFromImage: true });
        expect(r).toMatchObject({ ok: true, bet: { stake: 1 } });
      },
    );

    it.each([["Stake: 1/2u", 0.5], ["1/4u", 0.25], ["½u", 0.5]] as const)("fração '%s' na legenda vale a fração", (line, stake) => {
      expect(extractCaptionBetHints(`Over 2.5 @1.90\n${line}`)).toEqual({ stake, odds: 1.9 });
    });

    it.each(['1,2,3u', '1.2.3.4u', '-1u', '-1/2u', '0u'])("stake inválida explícita %s não usa a stake do print", (line) => {
      const read = { ...base, mercado: 'Total', selecao: 'Over 2.5', odds: 1.9, stake: 1 };
      expect(finalizeParsedBetForCapture(read, `Over 2.5 @1.90\nStake: ${line}`, CapturePolicy.AUTO, { readFromImage: true }))
        .toEqual({ ok: false, missing: ['stake'], reason: 'stake_invalido' });
    });

    it.each(["Semana: +8,5u", "Fechamos o mês em +30u 🚀", "Saldo do dia -2u", "✅ +1,5u no bolso", "+1,5u ✅", "❌ -1u"])("resultado com sinal não é stake nem a torna ilegível: %s", (result) => {
      expect(extractCaptionBetHints(`Flamengo ML @1.90 1u\n${result}`)).toEqual({ stake: 1, odds: 1.9 });
      expect(finalizeParsedBetForCapture({ ...base, odds: 1.9 }, `Flamengo ML @1.90 1u\n${result}`, CapturePolicy.AUTO))
        .toMatchObject({ ok: true, bet: { stake: 1 } });
    });

    it.each(['Máx 1/2u', 'Retorno 1/2u'])("fração no limite/retorno %s não sobrescreve a stake da aposta", (annotation) => {
      expect(extractCaptionBetHints(`${annotation}\n1/4u`)).toEqual({ stake: 0.25 });
      expect(parseUniversalBetPost(`Flamengo vs Palmeiras\nOver 2.5 @1.90\n${annotation}\n1/4u`)).toMatchObject({ ok: true, bet: { stake: 0.25 } });
    });

    it("intervalo '1-2u' na legenda não troca a stake do print por uma das pontas: o dono informa", () => {
      const read = { ...base, mercado: "Total", selecao: "Over 2.5", odds: 1.9, stake: 1 };
      expect(finalizeParsedBetForCapture(read, "Over 2.5 @1.90\nStake: 1-2u", CapturePolicy.AUTO, { readFromImage: true }))
        .toEqual({ ok: false, missing: ["stake"], reason: "stake_invalido" });
      expect(finalizeParsedBetForCapture(read, "Over 2.5 @1.90\nStake: 1/2u", CapturePolicy.AUTO, { readFromImage: true }))
        .toMatchObject({ ok: true, bet: { stake: 0.5 } });
    });

    it("'Meta: 10u | Stake: 1u': o separador depois da meta encerra o contexto dela", () => {
      expect(extractCaptionBetHints("Over 2.5 @1.90\nMeta: 10u | Stake: 1u")).toEqual({ stake: 1, odds: 1.9 });
    });

    it("'Nunca passe de 5u' não faz a legenda parecer ter duas apostas", () => {
      const r = finalizeParsedBetForCapture(base, "Flamengo ML @1.85\n1u\nGestão: nunca passe de 5u por dia", CapturePolicy.AUTO);
      expect(r).toMatchObject({ ok: true, bet: { stake: 1 } });
    });

    it.each([
      ["Gestão: 1u", 1],
      ["Gestão: 0,5 unidade", 0.5],
      ["💰 Gestão 2u", 2],
      ["1u (gestão: 1% da banca)", 1],
      ["Stake: 1u → Lucro: 0.85u", 1],
      ["Stake 1 unid", 1],
    ])("'%s' é a stake desta aposta", (line, stake) => {
      expect(extractCaptionBetHints(line)).toEqual({ stake });
    });

    // O registro refaz a stake pela política gravada no snapshot e recusa quando ela diverge.
    const stakeTheRegistryRecomputes = (bet: ParsedBetPost) =>
      bet.stakePolicySnapshot ? resolveCaptureStake(bet.stakePolicySnapshot.originalStake, bet.stakePolicySnapshot).stake : bet.stake;

    it("stake da legenda que a leitura não viu atualiza o snapshot da política (banca WHEN_MISSING)", () => {
      const read = resolveCaptureStake(null, { stakePolicy: "WHEN_MISSING", defaultStakeUnits: 1 });
      const bet = { ...base, odds: 2.1, stake: read.stake!, stakePolicySnapshot: read.snapshot };
      const r = finalizeParsedBetForCapture(bet, "Flamengo x Palmeiras\nEntrada: Flamengo\n@2.10\n2 units", CapturePolicy.AUTO);
      expect(r).toMatchObject({ ok: true, bet: { stake: 2, stakePolicySnapshot: { stakePolicy: "WHEN_MISSING", originalStake: 2, source: "message" } } });
      if (r.ok) expect(stakeTheRegistryRecomputes(r.bet)).toBe(r.bet.stake);
      expect(finalizeParsedBetForCapture(bet, "Flamengo ML @2.10\n50 units", CapturePolicy.AUTO))
        .toEqual({ ok: false, missing: ["stake"], reason: "stake_implausivel" });
    });

    // O lote de props passa ao guard a stake de cada item como legenda ("25u").
    it.each([1, 25])("stake padrão da banca WHEN_MISSING (%su) que volta como legenda do lote continua da banca", (defaultStakeUnits) => {
      const read = resolveCaptureStake(0, { stakePolicy: "WHEN_MISSING", defaultStakeUnits }, { zeroIsMissing: true });
      const bet = { ...base, odds: 2.1, stake: read.stake!, stakePolicySnapshot: read.snapshot };
      expect(finalizeParsedBetForCapture(bet, `${bet.stake}u`, CapturePolicy.AUTO)).toMatchObject({
        ok: true, bet: { stake: defaultStakeUnits, stakePolicySnapshot: { originalStake: 0, source: "bankroll_default" } },
      });
    });

    it("stake da legenda diferente da lida no print atualiza o snapshot da política (banca MESSAGE)", () => {
      const read = resolveCaptureStake(10, { stakePolicy: "MESSAGE", defaultStakeUnits: null });
      const bet = { ...base, odds: 2.1, stake: read.stake!, stakePolicySnapshot: read.snapshot };
      const r = finalizeParsedBetForCapture(bet, "Flamengo -0.5 @2.10\n1u", CapturePolicy.AUTO, { readFromImage: true });
      expect(r).toMatchObject({ ok: true, bet: { stake: 1, stakePolicySnapshot: { originalStake: 1, source: "message" } } });
      if (r.ok) expect(stakeTheRegistryRecomputes(r.bet)).toBe(r.bet.stake);
    });

    it.each([
      "Over 2.5 @1.90\n1u\nRetorno: 1.90u",
      "Over 2.5 @1.90\nStake: 1u (banca de 100u)",
      "Over 2.5 @1.90\n1u\nPossível ganho 0.9u",
      "Over 2.5 @1.90\n1u\nMês: 23.5u de lucro",
      "Over 2.5 @1.90\nRetorno 1.9u | Stake 1u",
      "Over 2.5 @1.90\nStake 1u retorno 1.90u",
      "Over 2.5 @1.90\n1u\nRetorno total: 1.90u",
      "Over 2.5 @1.90\n1u\nGanho estimado 0.9u",
      "Over 2.5 @1.90\n1u\nGanho líquido: 0.9u",
    ])("retorno, ganho possível, banca e lucro em unidades não fazem a legenda parecer ter duas apostas: %j", (caption) => {
      expect(extractCaptionBetHints(caption)).toEqual({ stake: 1, odds: 1.9 });
      expect(finalizeParsedBetForCapture({ ...base, mercado: "Total", selecao: "Over 2.5", odds: 1.9 }, caption, CapturePolicy.AUTO))
        .toMatchObject({ ok: true, bet: { stake: 1, odds: 1.9 } });
    });

    it.each([
      "Over 2.5 @1.90\nSe possível pegar acima de 1.85 - 2u",
      "Over 2.5 @1.90 (se possível 1.95+) 2u",
      "Over 2.5 @1.90\nPotencial de green alto, 2u",
    ])("'possível' e 'potencial' soltos antes da stake não apagam a dica da legenda: %j", (caption) => {
      expect(extractCaptionBetHints(caption)).toEqual({ stake: 2, odds: 1.9 });
    });

    it("'Ontem +12u' e '(máx 3u)' não viram stake", () => {
      expect(extractCaptionBetHints("Ontem fechamos +12u 🔥\n1u")).toEqual({ stake: 1 });
      expect(extractCaptionBetHints("Stake: 2u (máx 3u)")).toEqual({ stake: 2 });
    });
  });

  describe("legenda do post com várias apostas (item de lote lido do print)", () => {
    const item = (stake: number, odds = 1.85): ParsedBetPost => ({
      ...base, odds, stake, stakeSource: "image_units",
      stakePolicySnapshot: { version: 1, stakePolicy: "MESSAGE", defaultStakeUnits: null, originalStake: stake, source: "message" },
    });
    const shared = { readFromImage: true, sharedCaption: true };

    it("uma stake só na legenda não vira a de cada item: a que diverge da do print recusa", () => {
      expect(finalizeParsedBetForCapture(item(2), "Entradas de hoje\nStake: 1u", CapturePolicy.AUTO, shared))
        .toEqual({ ok: false, missing: ["stake"], reason: "stake_diverge_legenda" });
      expect(finalizeParsedBetForCapture(item(1), "Entradas de hoje\nStake: 1u", CapturePolicy.AUTO, shared))
        .toMatchObject({ ok: true, bet: { stake: 1 } });
    });

    it("com \"cada\", a stake da legenda vale para todos os itens", () => {
      expect(finalizeParsedBetForCapture(item(2), "Entradas de hoje\n1u cada", CapturePolicy.AUTO, shared))
        .toMatchObject({ ok: true, bet: { stake: 1, stakePolicySnapshot: { originalStake: 1, source: "message" } } });
    });

    it.each(["Total: 3u", "Stake total: 1u"])("a soma do lote (%s) não é a stake de um item", (line) => {
      expect(finalizeParsedBetForCapture(item(2), `Entradas de hoje\n${line}`, CapturePolicy.AUTO, shared))
        .toMatchObject({ ok: true, bet: { stake: 2 } });
    });

    it("\"0.5u cada (total 1u)\" é uma stake só, não duas apostas na legenda", () => {
      expect(finalizeParsedBetForCapture(item(0.5), "Entradas de hoje\n0.5u cada (total 1u)", CapturePolicy.AUTO, shared))
        .toMatchObject({ ok: true, bet: { stake: 0.5 } });
    });

    it("duas stakes diferentes na legenda continuam recusando", () => {
      expect(finalizeParsedBetForCapture(item(1), "Flamengo 1u\nCorinthians 2u", CapturePolicy.AUTO, shared))
        .toEqual({ ok: false, missing: ["aposta"], reason: "legenda_com_multiplas_apostas" });
    });

    it("banca CAPTION_ODD: a odd única da legenda não substitui a do print de cada item, e a divergência grande recusa", () => {
      expect(finalizeParsedBetForCapture(item(1, 1.9), "Entradas de hoje @1.85\n1u cada", CapturePolicy.CAPTION_ODD, shared))
        .toMatchObject({ ok: true, bet: { odds: 1.9 } });
      expect(finalizeParsedBetForCapture(item(1, 1.9), "Entradas de hoje @2.60\n1u cada", CapturePolicy.CAPTION_ODD, shared))
        .toEqual({ ok: false, missing: ["odds"], reason: "odd_diverge_legenda" });
    });
  });

  describe("handicap ao vivo e tipo de handicap", () => {
    const ah = { ...base, mercado: "Asian Handicap", selecao: "Flamengo -0.5", odds: 1.9 };

    it("'AO VIVO 1x0' e 'Placar: 1-0' são o placar da entrada", () => {
      expect(finalizeParsedBetForCapture(ah, "AO VIVO 1x0\nFlamengo -0.5 @1.90 1u", CapturePolicy.AUTO))
        .toMatchObject({ ok: true, bet: { liveScoreHome: 1, liveScoreAway: 0 } });
      expect(finalizeParsedBetForCapture(ah, "Placar: 1-0\nFlamengo -0.5 @1.90 1u", CapturePolicy.AUTO))
        .toMatchObject({ ok: true, bet: { liveScoreHome: 1, liveScoreAway: 0 } });
    });

    it("horário do jogo entre parênteses na legenda não vira placar da entrada", () => {
      const lakers = { ...ah, evento: "Lakers vs Celtics", esporte: "Basketball", mercado: "Handicap", selecao: "Lakers -4.5", odds: 1.91 };
      for (const caption of ["🏀 (21:00) Lakers x Celtics\nLakers -4.5 @1.91 2u", "🏀 NBA - Lakers x Celtics\nLakers -4.5 (21:00)\n@1.91 | 2u"]) {
        const result = finalizeParsedBetForCapture(lakers, caption, CapturePolicy.AUTO);
        expect(result).toMatchObject({ ok: true });
        expect(result.ok && [result.bet.liveScoreHome, result.bet.liveScoreAway]).toEqual([undefined, undefined]);
      }
    });

    it("horário ou data colados à seleção saem dela; o par que pode ser placar de basquete segue recusado", () => {
      const read = (selecao: string, mercado = "Handicap") => {
        const post = `Jogo: Lakers x Celtics\nMercado: ${mercado}\nEntrada: ${selecao}\nOdd: 1.91\nStake: 2u`;
        const parsed = parseUniversalBetPost(post);
        if (!parsed.ok) throw new Error(`leitura por regra falhou: ${parsed.missing.join(",")}`);
        return finalizeParsedBetForCapture({ ...parsed.bet, esporte: "Basketball" }, post, CapturePolicy.AUTO);
      };
      for (const selecao of ["Lakers -4.5 (21:00)", "(21:00) Lakers -4.5", "Lakers -4.5 (19-09)"]) {
        const result = read(selecao);
        expect(result, selecao).toMatchObject({ ok: true, bet: { selecao: "Lakers -4.5" } });
        expect(result.ok && [result.bet.liveScoreHome, result.bet.liveScoreAway], selecao).toEqual([undefined, undefined]);
      }
      expect(read("(20:45) Lakers -4.5")).toEqual({ ok: false, missing: ["selecao"], reason: "linha_handicap_ausente" });
      // O time no mercado e a linha sozinha na entrada: o sinal fica, senão o handicap se inverte.
      expect(read("-4.5 (21:00)", "Handicap Lakers")).toMatchObject({ ok: true, bet: { selecao: "-4.5" } });
      expect(read("+2.5 (20:00)", "Handicap Lakers")).toMatchObject({ ok: true, bet: { selecao: "+2.5" } });
    });

    it("'🔴 AO VIVO' sem placar num handicap é recusa", () => {
      expect(finalizeParsedBetForCapture(ah, "🔴 AO VIVO\nFlamengo -0.5 @1.90 1u", CapturePolicy.AUTO))
        .toEqual({ ok: false, missing: ["placarLive"], reason: "placar_ao_vivo_ausente" });
    });

    it("'Handicap' sem tipo com linha inteira no futebol é recusa; linha de meio segue", () => {
      expect(finalizeParsedBetForCapture({ ...ah, mercado: "Handicap", selecao: "Flamengo -1" }, "⚽", CapturePolicy.AUTO))
        .toEqual({ ok: false, missing: ["mercado"], reason: "handicap_tipo_ambiguo" });
      expect(finalizeParsedBetForCapture({ ...ah, mercado: "Handicap", selecao: "Flamengo -1.5" }, "⚽", CapturePolicy.AUTO))
        .toMatchObject({ ok: true });
    });

    it.each([
      ["🏀 NBA", "Lakers vs Celtics", "Lakers -5"],
      ["🎾 ATP", "Sinner vs Alcaraz", "Sinner -3"],
    ])("'Handicap' em esporte sem empate (%s) segue asiático", (caption, evento, selecao) => {
      expect(finalizeParsedBetForCapture({ ...ah, evento, mercado: "Handicap", selecao }, caption, CapturePolicy.AUTO))
        .toMatchObject({ ok: true });
    });

    it("'Handicap' de linha inteira com o esporte ainda não lido pergunta o tipo, salvo canal só de esportes sem empate", () => {
      const unread = { ...ah, esporte: "Unknown", mercado: "Handicap", selecao: "Flamengo -1" };
      expect(finalizeParsedBetForCapture(unread, "1u", CapturePolicy.AUTO, { readFromImage: true }))
        .toEqual({ ok: false, missing: ["mercado"], reason: "handicap_tipo_ambiguo" });
      expect(finalizeParsedBetForCapture(unread, "1u", CapturePolicy.AUTO, { readFromImage: true, channelSports: ["Soccer", "Basketball"] }))
        .toEqual({ ok: false, missing: ["mercado"], reason: "handicap_tipo_ambiguo" });
      expect(finalizeParsedBetForCapture(unread, "1u", CapturePolicy.AUTO, { readFromImage: true, channelSports: ["Basketball", "Tennis"] }))
        .toMatchObject({ ok: true });
    });

    it("'Handicap – Match' de linha inteira também pergunta o tipo quando nada no post o diz", () => {
      const asMatch = { ...ah, mercado: "Handicap – Match", selecao: "Flamengo -1" };
      expect(finalizeParsedBetForCapture(asMatch, "⚽ Flamengo -1 @1.90 1u", CapturePolicy.AUTO))
        .toEqual({ ok: false, missing: ["mercado"], reason: "handicap_tipo_ambiguo" });
      for (const caption of ["⚽ Flamengo -1 AH @1.90 1u", "⚽ Handicap Asiático: Flamengo -1 @1.90 1u", "⚽ Flamengo -1 (3 vias) @1.90 1u"]) {
        expect(finalizeParsedBetForCapture(asMatch, caption, CapturePolicy.AUTO)).toMatchObject({ ok: true });
      }
      expect(finalizeParsedBetForCapture({ ...asMatch, mercado: "Handicap Asiático" }, "⚽ Flamengo -1 @1.90 1u", CapturePolicy.AUTO))
        .toMatchObject({ ok: true });
      expect(finalizeParsedBetForCapture({ ...asMatch, selecao: "Flamengo -1.5" }, "⚽ Flamengo -1.5 @1.90 1u", CapturePolicy.AUTO))
        .toMatchObject({ ok: true });
    });

    it("rodapé de divulgação com 'live' não torna o handicap pré-jogo ao vivo", () => {
      const caption = "Flamengo -0.5 @1.90 1u\n\n📺 Acompanhe nossa live no YouTube";
      expect(finalizeParsedBetForCapture(ah, caption, CapturePolicy.AUTO)).toMatchObject({ ok: true });
      expect(finalizeParsedBetForCapture(ah, "Bora pra mais um green\nFlamengo -0.5 @1.90 1u\nLive 🔴 amanhã às 20h", CapturePolicy.AUTO))
        .toMatchObject({ ok: true });
    });
  });
});


describe("termos promocionais na captura", () => {
  it.each([
    "Aposta grátis", "Free bet usada: 1u", "Freebet (stake não retorna)", "Entrada com freebet", "Stake em bônus",
    "Aposta sem risco", "Reembolsada se perder", "Pagamento antecipado: 2 gols de vantagem",
  ])("não grava como dinheiro comum: %s", (terms) => {
    for (const policy of [CapturePolicy.AUTO, CapturePolicy.IMAGE_ODD, CapturePolicy.CAPTION_ODD]) {
      expect(finalizeParsedBetForCapture(base, `1u @1.85\n${terms}`, policy))
        .toMatchObject({ ok: false, reason: "unsupported_promotion_terms" });
      expect(validateParsedBetBeforeRegister(base, `1u @1.85\n${terms}`, policy))
        .toMatchObject({ ok: false, reason: "unsupported_promotion_terms" });
    }
  });
  it.each(["Tipo: aposta grátis", "Aposta feita com free bet", "Feita com freebet", "Pagamento: free bet", "Tipo: aposta sem risco"])("linha da legenda que rotula o financiamento desta aposta recusa: %s", (label) => {
    expect(finalizeParsedBetForCapture({ ...base, odds: 1.9 }, `Flamengo ML @1.90 1u\n${label}`, CapturePolicy.AUTO))
      .toMatchObject({ ok: false, reason: "unsupported_promotion_terms" });
  });
  it.each([
    "🎁 Deposite R$50 e ganhe R$50 em apostas grátis: bit.ly/x",
    "Primeira aposta sem risco na KTO 👉 link",
    "bet365 - Pagamento Antecipado",
    "Casa nova: cadastre-se e ganhe 100 em free bet",
    "Faça sua aposta com bônus de 100% na Betano",
  ])("rodapé de afiliado na legenda não recusa a aposta: %s", (footer) => {
    const caption = `Flamengo ML @1.90 1u\n${footer}`;
    expect(finalizeParsedBetForCapture({ ...base, odds: 1.9 }, caption, CapturePolicy.AUTO)).toMatchObject({ ok: true, bet: { stake: 1, odds: 1.9 } });
    expect(validateParsedBetBeforeRegister({ ...base, odds: 1.9 }, caption, CapturePolicy.AUTO)).toMatchObject({ ok: true });
  });
  it.each(["mercado", "selecao"] as const)("'Pagamento Antecipado' no %s da aposta continua recusado", (field) => {
    expect(finalizeParsedBetForCapture({ ...base, [field]: `${base[field]} - Pagamento Antecipado` }, "1u @1.85", CapturePolicy.AUTO))
      .toMatchObject({ ok: false, reason: "unsupported_promotion_terms" });
  });
  it("termo promocional na perna da múltipla continua recusado", () => {
    const legs = { kind: "parlay" as const, legs: [
      { evento: "Flamengo vs Palmeiras", mercado: "Moneyline", selecao: "Flamengo" },
      { evento: "Santos vs Bahia", mercado: "Aposta grátis", selecao: "Santos" },
    ] };
    expect(validateParsedBetBeforeRegister({ ...base, legs }, "1u @1.85", CapturePolicy.AUTO))
      .toMatchObject({ ok: false, reason: "unsupported_promotion_terms" });
  });
  it.each(["Bônus de cadastro: 10u", "Cashback: 5u", "Ganhe 10u de bônus", "Ganhe 5u em freebets"])("oferta não altera a stake: %s", (offer) => {
    expect(extractCaptionBetHints(`1u @1.85\n${offer}`)).toEqual({ stake: 1, odds: 1.85 });
    expect(finalizeParsedBetForCapture(base, `1u @1.85\n${offer}`, CapturePolicy.AUTO))
      .toMatchObject({ ok: true, bet: { stake: 1 } });
  });
  it.each(["Odd turbinada @1.85", "Empate sem risco", "Reembolsada se empatar", "Reembolsada se o jogador não atuar", "Sem pagamento antecipado", "Freebet não usada", "Substituição+", "Ganhe uma freebet com o cupom ABC"])("preserva aposta comum e proteção de jogador: %s", (text) => {
    expect(finalizeParsedBetForCapture(base, `1u @1.85\n${text}`, CapturePolicy.AUTO)).toMatchObject({ ok: true });
  });
});


describe("direção financeira da operação", () => {
  it.each(["Lay Flamengo", "Aposta contra Flamengo", "Cash-out parcial: 50%", "Responsabilidade: 3u", "Comissão: 5%", "Comissão: 1,5%", "Commission: 0.5%", "Lay: Flamengo @4.0\nComissão: 5%"])("não calcula como back comum: %s", (terms) => {
    expect(finalizeParsedBetForCapture(base, `1u @1.85\n${terms}`, CapturePolicy.AUTO))
      .toMatchObject({ ok: false, reason: "unsupported_trading_terms" });
    expect(validateParsedBetBeforeRegister({ ...base, selecao: terms }, "1u @1.85", CapturePolicy.AUTO)).toMatchObject({ ok: false, reason: "unsupported_trading_terms" });
  });
  it.each(["Lay Flamengo @2.0", "Tipo: lay", "Responsabilidade: 50", "Responsabilidade R$ 50", "Comissão: 5%", "Contra: Flamengo"])("linha da legenda que rotula a operação desta aposta recusa: %s", (label) => {
    expect(finalizeParsedBetForCapture({ ...base, odds: 1.9 }, `Flamengo ML @1.90 1u\n${label}`, CapturePolicy.AUTO))
      .toMatchObject({ ok: false, reason: "unsupported_trading_terms" });
  });
  it.each([
    "Responsabilidade sempre, jogue com moderação +18",
    "Contra tudo e contra todos 🔥",
    "Contra o Flamengo hoje não dá: Palmeiras ML",
    "Contra-ataque: over 2.5",
    "LeBron lay-up",
  ])("frase comum na legenda não vira lay nem responsabilidade: %s", (line) => {
    const caption = `Flamengo ML @1.90 1u\n${line}`;
    expect(finalizeParsedBetForCapture({ ...base, odds: 1.9 }, caption, CapturePolicy.AUTO)).toMatchObject({ ok: true, bet: { stake: 1, odds: 1.9 } });
    expect(validateParsedBetBeforeRegister({ ...base, odds: 1.9 }, caption, CapturePolicy.AUTO)).toMatchObject({ ok: true });
  });
  it.each(["Back Flamengo", "Aposta a favor do Flamengo", "Cobertura: Palmeiras ou Empate", "Proteção: Under 3.5", "Lay não utilizado", "Cashout disponível: 0,8u", "Cash-out parcial quando atingir 1u", "Cashout parcial disponível", "Comissão: 0%"])("preserva bilhete independente e oferta: %s", (terms) => {
    expect(finalizeParsedBetForCapture(base, `1u @1.85\n${terms}`, CapturePolicy.AUTO)).toMatchObject({ ok: true });
  });
});
it("valor oferecido de cash-out não substitui stake na mesma linha", () => {
  expect(extractCaptionBetHints("Cashout disponível: 0,8u Stake: 1u @1.85")).toEqual({ stake: 1, odds: 1.85 });
  expect(extractCaptionBetHints("Cash-out disponível: 0,8u")).toEqual({});
});
