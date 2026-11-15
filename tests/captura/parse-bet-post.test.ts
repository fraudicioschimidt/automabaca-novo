import { describe, expect, it } from "vitest";
import { parseBrKickoffDetailed, spToUtc } from "@/src/domain/dates";
import { marketPeriodOf } from "@/src/domain/mercados/classify";
import { coerceMercadoPelaSelecao } from "@/src/domain/mercados/coerce";
import { finalizePinnacleMarket, pinnacleizeMercado } from "@/src/domain/mercados/finalize";
import { pinnacleizeSelecao } from "@/src/domain/mercados/selecao";
import { selecaoPareceHandicap } from "@/src/domain/mercados/selection-shape";
import { parseUniversalBetPost } from "@/src/domain/parse-bet-post";
import { sportPendingMessage } from "@/src/domain/sport-pending";
import { flashscoreDateRetryAt } from "@/src/providers/flashscore/date-window";
import { candidateHints } from "@/src/services/bets/sport-resolution/decision";
import { MATCH_WINNER_POST } from "../fixtures/match-winner-post";
import { productionMarketCatalogClient } from "../fixtures/mercados-alias-producao";
import { kickoffInferidoFromParsed } from "@/src/domain/kickoff-infer";
import { resolveResultFromScore } from "@/src/domain/settlement/score-resolution";
import { finalizeParsedBetForCapture } from "@/src/services/capture/preparation/parse-capture-guard";
import { normalizeBetFields } from "@/src/services/bets/normalize-fields";

/** Só o instante: o que sobra de `parseBrKickoffDetailed` quando `dateOnly` não importa. */
const parseBrKickoff = (text: string, ref?: Date): Date | null => parseBrKickoffDetailed(text, ref)?.date ?? null;

const NOW = new Date("2026-06-10T12:00:00Z");

describe("parseBrKickoff (fuso São Paulo)", () => {
  it.each([
    "Odd 2.11 - 20h",
    "Odd: 2.11 20h",
    "Entrada: Over 2/2.5",
    "Flamengo -1/1.5",
    "Over 9/9.5 escanteios",
    "Handicap 1/1.5",
    "Jogo 2/7 da série",
  ])("odd, linha dividida e jogo da série não são data: %s", (text) => {
    expect(parseBrKickoff(text, NOW)).toBeNull();
  });

  it("a data escrita depois da linha dividida continua valendo", () => {
    expect(parseBrKickoff("Over 2/2.5\n15/06 16:00", NOW)?.toISOString()).toBe("2026-06-15T19:00:00.000Z");
    expect(parseBrKickoff("Flamengo x Palmeiras - 15/06 16:00", NOW)?.toISOString()).toBe("2026-06-15T19:00:00.000Z");
  });

  // NOW é quarta-feira, 10/06/2026, 09:00 em São Paulo.
  it.each([
    ["hoje 21:30", "2026-06-11T00:30:00.000Z"],
    ["Hoje às 20h", "2026-06-10T23:00:00.000Z"],
    ["amanhã 16:00", "2026-06-11T19:00:00.000Z"],
    ["Sábado 16:00", "2026-06-13T19:00:00.000Z"],
    ["quarta-feira, 19h30", "2026-06-10T22:30:00.000Z"],
    ["Terça 21:00", "2026-06-17T00:00:00.000Z"],
  ])("dia relativo com hora: %s", (text, iso) => {
    expect(parseBrKickoffDetailed(text, NOW)).toEqual({ date: new Date(iso), dateOnly: false });
  });

  it.each(["Segunda Divisão 16:00", "hoje tem jogo", "Over 2.5 hoje", "amanhã 2.5"])("sem dia relativo com hora: %s", (text) => {
    expect(parseBrKickoff(text, NOW)).toBeNull();
  });

  it("dd/mm hh:mm em SP vira UTC+3h", () => {
    expect(parseBrKickoff("15/06 16:00", NOW)?.toISOString()).toBe(
      "2026-06-15T19:00:00.000Z",
    );
  });

  it("sem ano: passado distante rola para o ano seguinte", () => {
    expect(parseBrKickoff("05/01 20:00", NOW)?.toISOString()).toBe(
      "2027-01-05T23:00:00.000Z",
    );
  });

  it("variações: ponto, 'às', ano explícito, sem hora", () => {
    expect(parseBrKickoff("15.06.2026 às 16:00", NOW)?.toISOString()).toBe(
      "2026-06-15T19:00:00.000Z",
    );
    expect(parseBrKickoff("Dia 15/06", NOW)?.toISOString()).toBe(
      "2026-06-15T03:00:00.000Z",
    );
    expect(parseBrKickoff("sem data aqui", NOW)).toBeNull();
  });

  it("spToUtc é a única fonte de conversão", () => {
    expect(
      spToUtc({ year: 2026, month: 8, day: 1, hour: 21, minute: 30 }).toISOString(),
    ).toBe("2026-08-02T00:30:00.000Z");
  });
});

describe("parseUniversalBetPost", () => {
  it("formato rotulado (estilo Carteira Premium)", () => {
    const result = parseUniversalBetPost(
      [
        "🏆 Carteira Premium",
        "Jogo: Coquimbo Unido vs Colo Colo",
        "Liga: Primera División",
        "Data: 15/06 16:00",
        "Mercado: Total",
        "Entrada: Over 2.5",
        "ODD: 1.91",
        "Stake: 1u",
      ].join("\n"),
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bet.evento).toBe("Coquimbo Unido vs Colo Colo");
    expect(result.bet.competicao).toBe("Primera División");
    expect(result.bet.mercado).toBe("Total");
    expect(result.bet.selecao).toBe("Over 2.5");
    expect(result.bet.odds).toBe(1.91);
    expect(result.bet.stake).toBe(1);
    expect(result.bet.data?.toISOString()).toBe("2026-06-15T19:00:00.000Z");
  });

  it("formato compacto com @ e unidade inline", () => {
    const result = parseUniversalBetPost(
      ["⚽ Santos x Grêmio", "Entrada: Santos +0.5 @1.85", "0,5u"].join("\n"),
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bet.evento).toBe("Santos vs Grêmio");
    expect(result.bet.selecao).toBe("Santos +0.5 @1.85");
    expect(result.bet.odds).toBe(1.85);
    expect(result.bet.stake).toBe(0.5);
    expect(result.bet.mercado).toBe("Asian Handicap"); // inferido da seleção
    expect(result.bet.esporte).toBe("Soccer");
  });

  it("dupla Target vira pernas, não um evento mashado", () => {
    const result = parseUniversalBetPost(
      [
        "Tipster: Target",
        "Data: 15/08/2026",
        "Jogo: Mogi das Cruzes x Bauru/ Bayamon x Aguadas",
        "Entrada: Mogi ML HT FT / Bayamon ML",
        "ODD: 1.83",
        "Stake: 1.3333334u",
      ].join("\n"),
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bet.evento).toContain(" | ");
    expect(result.bet.legs?.kind).toBe("parlay");
    expect(result.bet.legs?.legs).toHaveLength(2);
  });

  it("combo do mesmo jogo vira duas pernas", () => {
    const result = parseUniversalBetPost(
      [
        "Tipster: Target",
        "Data: 15/08/2026",
        "Jogo: Mogi das cruzes x Bauru",
        "Entrada: Mogi ML H5 FT + Mogi O89,5",
        "ODD: 4",
        "Stake: 0.666667u",
      ].join("\n"),
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bet.legs?.kind).toBe("same_game");
    expect(result.bet.legs?.legs).toHaveLength(2);
  });

  it("o período do 'Mercado:' vale para as pernas do combo", () => {
    const result = parseUniversalBetPost(
      ["Jogo: Flamengo x Palmeiras", "Mercado: 1º Tempo", "Entrada: Over 0.5 + Flamengo", "Odd: 2.10", "Stake: 1u"].join("\n"),
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bet.legs?.legs.map((leg) => marketPeriodOf(leg.mercado))).toEqual(["HT", "HT"]);
    expect(marketPeriodOf(result.bet.mercado)).toBe("HT");
  });

  it("infere cartões quando a entrada é time + O.linha cards", () => {
    const result = parseUniversalBetPost(
      [
        "Tipster: Target",
        "Data: 14/08/2026",
        "Jogo: Wolverhampton x Blackburn",
        "Entrada: Wolves O.1,5 cards",
        "ODD: 1.76",
        "Stake: 1.3333334u",
      ].join("\n"),
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bet.evento).toBe("Wolverhampton vs Blackburn");
    expect(result.bet.selecao).toBe("Wolves O.1,5 cards");
    expect(result.bet.mercado).toBe("Total Cards");
  });

  it("detecta basquete por emoji e vírgula decimal na odd", () => {
    const result = parseUniversalBetPost(
      ["🏀 Lakers vs Celtics", "Aposta: Over 215.5", "Odd: 1,90", "Stake: 2"].join("\n"),
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bet.esporte).toBe("Basketball");
    expect(result.bet.odds).toBe(1.9);
  });

  it("usa o parser decimal canônico e rejeita valores fora dos tetos", () => {
    const valid = parseUniversalBetPost(
      ["⚽ A vs B", "Entrada: A", "Odd: 1,900", "Stake: 0,50u"].join("\n"),
      { now: NOW },
    );
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.bet.odds).toBe(1.9);
      expect(valid.bet.stake).toBe(0.5);
    }

    const invalid = parseUniversalBetPost(
      ["⚽ A vs B", "Entrada: A", "Odd: 1.000,01", "Stake: 0,50u"].join("\n"),
      { now: NOW },
    );
    expect(invalid).toMatchObject({ ok: false, missing: expect.arrayContaining(["odds"]) });
  });

  it("falha com lista do que faltou (vai para o Gemini na próxima fatia)", () => {
    const result = parseUniversalBetPost("⚽ Flamengo vs Palmeiras\nGrande jogo hoje!", {
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toContain("odds");
    expect(result.missing).toContain("stake");
  });

  it("nao interpreta handles numericos como odds", () => {
    const result = parseUniversalBetPost(
      ["⚽ Santos vs Gremio", "Entrada: Santos", "Siga @2gols e @10tips", "1u"].join("\n"),
      { now: NOW },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toContain("odds");
  });

  it("aceita stake numérica nua somente na linha imediatamente após a odd", () => {
    const result = parseUniversalBetPost(
      ["⚽ Santos vs Gremio", "Entrada: Santos", "@1.90", "1.5"].join("\n"),
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bet.stake).toBe(1.5);

    const separated = parseUniversalBetPost(
      ["⚽ Santos vs Gremio", "Entrada: Santos", "@1.90", "comentário", "1.5"].join("\n"),
      { now: NOW },
    );
    expect(separated).toMatchObject({ ok: false, missing: expect.arrayContaining(["stake"]) });

    const horario = parseUniversalBetPost(
      ["⚽ Santos vs Gremio", "Entrada: Santos", "@1.90", "19.30"].join("\n"),
      { now: NOW },
    );
    expect(horario).toMatchObject({ ok: false, missing: expect.arrayContaining(["stake"]) });
  });

  it("não inventa handicap para seleção composta apenas por linha assinada", () => {
    const result = parseUniversalBetPost(
      ["🎾 Sinner vs Fritz", "Entrada: +22.5", "@1.90", "1u"].join("\n"),
      { now: NOW },
    );
    expect(result).toEqual({ ok: false, missing: ["mercado"] });
  });
});

describe("post com escanteios colados na linha (Entrada/Mínima)", () => {
  it.each([
    ["Over 9Cantos", "Total (Corners) – Match", "Over 9.0"],
    ["Over 8Cantos", "Total (Corners) – Match", "Over 8.0"],
    ["Under 8,5Cantos", "Total (Corners) – Match", "Under 8.5"],
    ["Over 9.5corners 1st half", "Total (Corners) – 1st Half", "Over 9.5"],
    ["Atlanta United +0 Cantos", "Handicap (Corners) – Match", "Atlanta United +0"],
  ])("preserva direção, linha e unidade de %s", (selection, expectedMarket, expectedSelection) => {
    const result = parseUniversalBetPost(`Tipster: Jorge Neves\nData: 09/09/2026\nJogo: Atlanta United vs. Orlando City\nEntrada: ${selection}\nODD: 1.85\nMínima: 1.79\nStake: 1u`);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("parse falhou");
    const mercado = finalizePinnacleMarket(coerceMercadoPelaSelecao(result.bet.mercado, selection, "Soccer", result.bet.evento), "Soccer");
    expect(mercado).toBe(expectedMarket);
    expect(pinnacleizeSelecao({ selecao: selection, mercadoPinnacle: mercado, evento: result.bet.evento })).toBe(expectedSelection);
    expect(result.bet.odds).toBe(1.85);
    expect(result.bet.stake).toBe(1);
    expect(result.bet.sportResolution?.status).toBe("PENDING");
  });

  it("time fora do confronto não vira Under 23 nem vencedor: a regra deixa para a IA", () => {
    const result = parseUniversalBetPost("Tipster: Jorge Neves\nData: 09/09/2026\nJogo: Atlanta United vs. Orlando City\nEntrada: Sporting U23\nODD: 1.85\nMínima: 1.79\nStake: 1u");
    expect(result).toEqual({ ok: false, missing: ["mercado"] });
  });

  it("cantos ordenam a busca, sem apagar evidência de outra modalidade", () => {
    expect(candidateHints({ mercado: "Moneyline", selecao: "Over 9Cantos", esporte: "Hockey" })).toEqual(["Soccer", "Hockey"]);
  });

  it("agenda datas distantes sem consultar fora de D+7 e usa o dia SP", () => {
    const now = new Date("2026-09-08T15:15:00Z");
    expect(flashscoreDateRetryAt("2026-09-15", now)).toBeNull();
    expect(flashscoreDateRetryAt("2026-09-19", now)?.toISOString()).toBe("2026-09-12T03:00:00.000Z");
    expect(flashscoreDateRetryAt("2026-09-20", now)?.toISOString()).toBe("2026-09-13T03:00:00.000Z");
    expect(flashscoreDateRetryAt("2026-09-15", new Date("2026-09-08T02:59:59Z"))?.toISOString()).toBe("2026-09-08T03:00:00.000Z");
    expect(flashscoreDateRetryAt("2026-09-19", new Date("2026-09-12T03:00:00Z"))).toBeNull();
  });

  it("explica espera e próxima tentativa sem apresentar código interno", () => {
    expect(sportPendingMessage({ reason: "outside_provider_window", retryAt: "2026-09-12T03:00:00Z" })).toBe("Aguardando a abertura da agenda do fornecedor. Nova tentativa em 12/09 00:00.");
    expect(sportPendingMessage({ reason: "provider_capacity", retryAt: "invalid" })).toBe("Aguardando capacidade do fornecedor.");
    expect(sportPendingMessage(null)).toBeNull();
  });
});

describe("cotação na seleção não é linha de handicap", () => {
  it.each([true, false])("Match Winner com cotação na seleção, com cabeçalho do grupo: %s", (withHeader) => {
    const text = withHeader ? MATCH_WINNER_POST : MATCH_WINNER_POST.replace("TPC Tips - FREE\n\n", "");
    const parsed = parseUniversalBetPost(text, { now: new Date("2026-09-09T02:57:00Z") });
    expect(parsed).toMatchObject({ ok: true, bet: { evento: "Chen-Yu Lu vs Natsuki Yamamoto", esporte: "Tennis", mercado: "Moneyline", odds: 2, stake: 2 } });
    if (!parsed.ok) return;
    const bet = parsed.bet;
    expect(bet.data?.toISOString()).toBe("2026-09-09T05:00:00.000Z");
    const market = coerceMercadoPelaSelecao(pinnacleizeMercado(bet.mercado, bet.esporte), bet.selecao, bet.esporte, bet.evento);
    expect(market).toBe("Match Winner");
    expect(pinnacleizeSelecao({ selecao: bet.selecao, mercadoPinnacle: market, evento: bet.evento })).toBe("Natsuki Yamamoto");
    expect(bet.legs).toBeUndefined();
  });

  it.each([
    ["Tennis", "Chen-Yu Lu vs Natsuki Yamamoto", "Natsuki Yamamoto @ 2.000"],
    ["Soccer", "Santos vs Grêmio", "Santos @2,00"],
    ["Basketball", "Lakers vs Celtics", "Celtics @ 1.95"],
    ["Baseball", "Yankees vs Mets", "Mets @2.000"],
    ["Counter-Strike", "FURIA vs NAVI", "NAVI @ 2.100"],
  ])("preserva vencedor em %s", (sport, event, selection) => {
    const market = pinnacleizeMercado("Moneyline", sport);
    expect(selecaoPareceHandicap(selection)).toBe(false);
    expect(coerceMercadoPelaSelecao(market, selection, sport, event)).toBe(market);
    expect(pinnacleizeSelecao({ selecao: selection, mercadoPinnacle: market, evento: event })).not.toContain("@");
  });

  it("preserva a linha real e os qualificadores antes da cotação", () => {
    const event = "Chen-Yu Lu vs Natsuki Yamamoto";
    const handicap = "Natsuki Yamamoto +2.5 @ 2.000";
    expect(coerceMercadoPelaSelecao("Match Winner", handicap, "Tennis", event)).toBe("Handicap (Games) – Match");
    expect(pinnacleizeSelecao({ selecao: handicap, mercadoPinnacle: "Handicap (Games) – Match", evento: event })).toBe("Natsuki Yamamoto +2.5");
    expect(pinnacleizeSelecao({ selecao: "Over 22.5 @ 1.90", mercadoPinnacle: "Total (Games) – Match", evento: event })).toBe("Over 22.5");
    expect(pinnacleizeSelecao({ selecao: "Natsuki Yamamoto 1st Set @ 2.000", mercadoPinnacle: "Match Winner", evento: event })).toBe("Natsuki Yamamoto 1st Set");
  });
});

const JOGO = "Jogo: Flamengo x Palmeiras\n";
const TIP_NOW = new Date("2026-09-23T15:00:00Z");
const readRule = (text: string) => parseUniversalBetPost(text, { now: TIP_NOW });

describe("leitor por regra: seleção que ele não entende vai para a IA", () => {
  it.each([
    "Palmeiras não perde", "Flamengo não vence", "Flamengo perde", "Contra Flamengo", "Flamengo marca",
    "Ambas marcam", "Over2.5", "2.5+ gols", "Placar exato 2x1",
  ])("'%s' não vira Moneyline do time", (entrada) => {
    expect(readRule(`${JOGO}Entrada: ${entrada}\n@1.90\n1u`)).toEqual({ ok: false, missing: ["mercado"] });
  });

  it.each([
    ["Flamengo", "Moneyline"], ["Flamengo vence", "Moneyline"], ["Empate", "Moneyline"],
    ["Flamengo DNB", "Moneyline"], ["Palmeiras dupla chance", "Moneyline"], ["Flamengo 0.0", "Asian Handicap"],
  ])("'%s' continua sendo lido pela regra (%s)", (entrada, mercado) => {
    expect(readRule(`${JOGO}Entrada: ${entrada}\n@1.90\n1u`)).toMatchObject({ ok: true, bet: { mercado } });
  });

  it("total que nomeia o time é total do time", () => {
    expect(readRule(`${JOGO}Entrada: Flamengo over 1.5 gols\n@1.90\n1u`)).toMatchObject({ ok: true, bet: { mercado: "Team Total" } });
    expect(readRule(`${JOGO}Entrada: Over 1.5 gols do Flamengo\n@1.90\n1u`)).toMatchObject({ ok: true, bet: { mercado: "Team Total" } });
    expect(readRule(`${JOGO}Entrada: Flamengo O 1.5\n@1.90\n1u`)).toMatchObject({ ok: true, bet: { mercado: "Team Total" } });
    expect(readRule(`${JOGO}Entrada: Palmeiras U 2,5\n@1.90\n1u`)).toMatchObject({ ok: true, bet: { mercado: "Team Total" } });
  });

  it.each(["Flamengo -1 (Handicap Europeu)", "Handicap 3 vias Flamengo -1"])("handicap europeu não vira asiático: %s", (entrada) => {
    expect(readRule(`${JOGO}Entrada: ${entrada}\n@1.90\n1u`)).toMatchObject({ ok: true, bet: { mercado: "European Handicap" } });
  });
});

describe("leitor por regra: seleção sem o rótulo \"Entrada:\"", () => {
  const post = (...lines: string[]) => ["⚽ Flamengo x Palmeiras", ...lines].join("\n");

  it.each([
    [["Over 2.5 gols", "@1.90", "1u"], "Over 2.5 gols", "Total"],
    [["Flamengo -0.5 @1.90", "1u"], "Flamengo -0.5", "Asian Handicap"],
    [["Flamengo", "@1.90", "1u"], "Flamengo", "Moneyline"],
    [["Flamengo over 1.5 gols", "Odd: 1.90", "Stake: 1u"], "Flamengo over 1.5 gols", "Team Total"],
  ])("a única linha solta que a regra entende vira a seleção: %j", (lines, selecao, mercado) => {
    expect(readRule(post(...lines))).toMatchObject({ ok: true, bet: { selecao, mercado, odds: 1.9, stake: 1 } });
  });

  it.each([
    ["negação", ["Palmeiras não perde", "@1.90", "1u"]],
    ["duas linhas soltas", ["Brasileirão Série A", "Over 2.5 gols", "@1.90", "1u"]],
    ["período na linha", ["Over 0.5 1º tempo", "@1.90", "1u"]],
    ["ao vivo sem rótulo", ["AO VIVO 1x0", "Flamengo -0.5", "@1.90", "1u"]],
    ["linha sem mercado", ["+22.5", "@1.90", "1u"]],
    ["mercado que a regra não classifica", ["Ambas marcam", "@1.90", "1u"]],
    ["combinação com '+'", ["Flamengo + Over 1.5", "@1.90", "1u"]],
    ["combinação com '&'", ["Flamengo & Over 1.5", "@1.90", "1u"]],
    ["período entre parênteses", ["Over 0.5 (1º T)", "@1.90", "1u"]],
    ["jogador com over", ["Pedro over 0.5 gols", "@1.90", "1u"]],
    ["handicap europeu abreviado", ["Flamengo -1 HE", "@1.90", "1u"]],
  ])("%s continua indo para a IA", (_caso, lines) => {
    expect(readRule(post(...lines))).toEqual({ ok: false, missing: ["selecao"] });
  });

  it("linha de odd mínima não vira seleção", () => {
    expect(readRule(["Luis / SL", "@1.80", "1u", "min 1,75"].join("\n"))).toEqual({ ok: false, missing: ["selecao"] });
    expect(readRule(["Luis / SL", "Flamengo x Palmeiras", "@1.90", "1u", "min 1,75"].join("\n")))
      .toEqual({ ok: false, missing: ["selecao"] });
    expect(readRule(post("@1.90", "1u", "máx 1,75"))).toEqual({ ok: false, missing: ["selecao"] });
  });

  it("múltipla sem rótulo continua sendo múltipla", () => {
    expect(readRule(post("Flamengo vence e Over 1.5 gols", "@2.60", "1u"))).toEqual({ ok: false, missing: ["multipla"] });
  });

  it("o total do time sem rótulo grava o mesmo mercado e seleção que o rotulado", () => {
    const parsed = readRule(post("Flamengo over 1.5 gols", "@1.90", "1u"));
    const labeled = readRule(`${JOGO}Entrada: Flamengo over 1.5 gols\n@1.90\n1u`);
    expect(parsed.ok && labeled.ok && { mercado: parsed.bet.mercado, selecao: parsed.bet.selecao })
      .toEqual(labeled.ok && { mercado: labeled.bet.mercado, selecao: labeled.bet.selecao });
  });
});

describe("leitor por regra: múltipla não é simples", () => {
  it.each([
    ["dupla com dois jogos", "🔥 DUPLA\nJogo: Flamengo x Palmeiras\nEntrada: Flamengo vence\nJogo: Santos x Grêmio\nEntrada: Over 2.5 gols\nOdd: 3.50\nStake: 1u"],
    ["criar aposta", "Jogo: Flamengo x Palmeiras\nCriar aposta\nEntrada: Flamengo vence\nEntrada: Over 1.5 gols\n@2.80\n1u"],
    ["tripla", "TRIPLA 🔥\nFlamengo x Palmeiras\nEntrada: Flamengo\nSantos x Grêmio\nBahia x Vitória\n@5.20\n0.5u"],
    ["'vence e'", "Jogo: Flamengo x Palmeiras\nEntrada: Flamengo vence e Over 1.5 gols\n@2.60\n1u"],
    ["acumulada", "Acumulada do dia\nJogo: Flamengo x Palmeiras\nEntrada: Flamengo\n@3.10\n1u"],
  ])("%s → IA", (_caso, text) => {
    expect(readRule(text)).toEqual({ ok: false, missing: ["multipla"] });
  });

  it("dupla chance é mercado, não dupla", () => {
    expect(readRule(`${JOGO}Entrada: Palmeiras dupla chance\n@1.40\n1u`)).toMatchObject({ ok: true });
  });
});

describe("leitor por regra: seleção combinada", () => {
  it.each([
    "Mercado: Ambas marcam\nEntrada: Sim e Over 2.5",
    "Entrada: Ambas marcam e Over 2.5",
    "Entrada: Flamengo e Over 1.5",
    "Mercado: Ambas marcam\nEntrada: Sim & Over 2.5",
    "Entrada: Over 2.5 e ambas marcam",
    "Entrada: Flamengo -0.5 e Under 3.5",
  ])("duas condições numa seleção vão para a IA separar as pernas: %j", (lines) => {
    expect(readRule(`${JOGO}${lines}\n@1.90\n1u`)).toEqual({ ok: false, missing: ["multipla"] });
  });

  it("nome de time com 'e' ou '&' não é combinada", () => {
    expect(readRule("Jogo: Brighton & Hove x Vitória e Bahia\nEntrada: Brighton & Hove\n@1.90\n1u"))
      .toMatchObject({ ok: true, bet: { mercado: "Moneyline", selecao: "Brighton & Hove" } });
  });
});

describe("leitor por regra: stake", () => {
  const stakeOf = (rest: string) => {
    const parsed = readRule(`${JOGO}Entrada: Flamengo ML\n@1.90\n${rest}`);
    return parsed.ok ? parsed.bet.stake : parsed.missing;
  };

  it.each([
    ["Ontem fechamos +12u 🔥", ["stake"]],
    ["Stake baixa\nMeta da semana: +15u", ["stake"]],
    ["Meia unidade\nNunca passe de 10u", 0.5],
    ["Valor: 50", ["stake"]],
    ["90", ["stake"]],
    ["Stake: 2%", 2],
  ] as const)("%s → %j", (rest, expected) => {
    expect(stakeOf(rest)).toEqual(expected);
  });

  it.each([
    ["Stake: 1/2u", 0.5],
    ["Stake: 1/4u", 0.25],
    ["3/4u", 0.75],
    ["½u", 0.5],
    ["Stake: 1½u", 1.5],
    ["Stake: ½", 0.5],
  ] as const)("fração '%s' vale a fração, não o denominador", (rest, stake) => {
    expect(stakeOf(rest)).toBe(stake);
  });

  it.each(["Stake: 1-2u", "Stake: 0,5-1u", "1 a 2u", "Stake: 3/10u", "Stake: -1/2u"])("'%s' não diz a stake: fica para o dono informar", (rest) => {
    expect(stakeOf(rest)).toEqual(["stake"]);
  });

  it("a odd colada antes do hífen não faz da stake um intervalo", () => {
    expect(readRule(`${JOGO}Entrada: Flamengo ML\n@1.50-2u`)).toMatchObject({ ok: true, bet: { stake: 2 } });
    expect(readRule(`${JOGO}Entrada: Flamengo ML\n@1.90 - 1u`)).toMatchObject({ ok: true, bet: { stake: 1 } });
  });

  it.each([
    ["Gestão: 1u", 1],
    ["Gestão: 0,5 unidade", 0.5],
    ["💰 Gestão 2u", 2],
    ["1u (gestão: 1% da banca)", 1],
    ["Stake: 1u → Lucro: 0.85u", 1],
  ] as const)("'%s' é a stake: só o número depois de meta, lucro e ontem fica de fora", (rest, stake) => {
    expect(stakeOf(rest)).toBe(stake);
  });

  it.each([
    ["Stake 2", 2],
    ["Stake 2%", 2],
    ["Unidades 2", 2],
    ["🎯 Stake 1", 1],
    ["2 units", 2],
    ["Stake 2 units", 2],
    ["1 unid", 1],
  ] as const)("'%s' sem dois-pontos ou em inglês é lida pela regra", (rest, stake) => {
    expect(stakeOf(rest)).toBe(stake);
  });

  it.each(["Stake 3/10", "💰 Stake: 3/10", "Stake: 2 de 5", "2%", "💰 2%"])(
    "stake escrita que a regra não lê ('%s') fica faltando, para a IA ler",
    (rest) => {
      expect(stakeOf(rest)).toEqual(["stake"]);
    },
  );

  it.each([
    ["Retorno: 1.90u\n1u", 1],
    ["Possível ganho 0.9u\n1u", 1],
    ["Retorno 1.9u | Stake 1u", 1],
    ["23.5u de lucro no mês\n1u", 1],
    ["Stake 1u retorno 1.90u", 1],
    ["Stake: 1u Retorno: 1.90u", 1],
    ["Ganho possível: 0.9u\n1u", 1],
    ["Retorno potencial de 1.9u\n1u", 1],
    ["Stake: 1u (banca de 100u)", 1],
    ["1u green", 1],
    ["Retorno total: 1.90u\n1u", 1],
    ["Ganho estimado 0.9u\n1u", 1],
    ["Ganho líquido: 0.9u\n1u", 1],
  ] as const)("'%s': retorno, ganho e lucro em unidades não são a stake", (rest, stake) => {
    expect(stakeOf(rest)).toBe(stake);
  });

  it.each([
    ["Meta da semana • 15u", ["stake"]],
    ["Meta semanal | 10u", ["stake"]],
    ["Lucro do mês • 12u", ["stake"]],
    ["Meta / 10u", ["stake"]],
    ["Meta: 10u | Stake: 1u", 1],
    ["Ontem +12u | Stake 1u", 1],
  ] as const)("o separador só encerra a meta ou o lucro depois das unidades deles: '%s' → %j", (rest, expected) => {
    expect(stakeOf(rest)).toEqual(expected);
  });

  it("meta com separador antes do número não vira a stake: o post fica com a stake faltando", () => {
    expect(readRule("Meta da semana • 15u\nFlamengo x Palmeiras\nEntrada: Over 2.5\n@1.90"))
      .toEqual({ ok: false, missing: ["stake"] });
  });

  it("'se possível' antes da stake na mesma linha não a apaga, e a banca WHEN_MISSING não troca pelo padrão", () => {
    const text = "Flamengo x Palmeiras\nOver 2.5 @1.90\nSe possível pegar acima de 1.85 - 2u";
    expect(readRule(text)).toMatchObject({ ok: true, bet: { stake: 2 } });
    expect(parseUniversalBetPost(text, { now: TIP_NOW, stakeSettings: { stakePolicy: "WHEN_MISSING", defaultStakeUnits: 1 } }))
      .toMatchObject({ ok: true, bet: { stake: 2, stakePolicySnapshot: { source: "message", originalStake: 2 } } });
  });

  it.each([
    "Over 2.5 @1.90 (se possível 1.95+) 2u",
    "Over 2.5 @1.90\nPotencial de green alto, 2u",
    "Over 2.5 @1.90\nRetorno garantido, 2u",
  ])("'possível', 'potencial' e 'retorno' soltos antes da stake não a apagam: %j", (entrada) => {
    // A regra não escolhe a seleção entre as linhas: a IA lê, sem stake faltando.
    const text = `Flamengo x Palmeiras\n${entrada}`;
    expect(readRule(text)).toEqual({ ok: false, missing: ["selecao"] });
    expect(parseUniversalBetPost(text, { now: TIP_NOW, stakeSettings: { stakePolicy: "WHEN_MISSING", defaultStakeUnits: 1 } }))
      .toEqual({ ok: false, missing: ["selecao"] });
  });

  it("número solto depois da odd até 10u continua sendo a stake", () => {
    expect(stakeOf("2")).toBe(2);
    expect(stakeOf("1u\nGestão: nunca passe de 5u por dia")).toBe(1);
  });
});

describe("leitor por regra: odd e data", () => {
  it("'Min @1.70' é o piso, não a odd", () => {
    expect(readRule(`${JOGO}Entrada: Over 2.5 gols\nMin @1.70\nStake: 1u`)).toEqual({ ok: false, missing: ["odds"] });
    expect(readRule(`${JOGO}Entrada: Over 2.5 gols\nMin @1.70\n@1.85\nStake: 1u`)).toMatchObject({ ok: true, bet: { odds: 1.85 } });
  });

  it.each([
    "Entrada: Over 2.5\n20h",
    "Entrada: Over 2.5 às 20h",
    "Entrada: Under 1.5 16:00",
  ])("linha de total com horário não vira data meses à frente: %s", (entrada) => {
    const parsed = readRule(`${JOGO}${entrada}\n@1.90\n1u`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.bet.data).toBeNull();
    expect(kickoffInferidoFromParsed(parsed.bet)).toBe(true);
  });

  it.each(["Confiança 5/5", "⭐ 3/5"])("nota do tipster '%s' não vira data", (nota) => {
    const parsed = readRule(`${JOGO}Entrada: Flamengo ML\n@1.90\n1u\n${nota}`);
    expect(parsed.ok && parsed.bet.data).toBeNull();
  });

  it.each(["Stake 3/10", "💰 Stake: 3/10"])("stake '%s' não vira data", (stake) => {
    const parsed = parseUniversalBetPost(`${JOGO}Entrada: Flamengo ML\n@1.90\n${stake}`, {
      now: TIP_NOW,
      stakeSettings: { stakePolicy: "ALWAYS", defaultStakeUnits: 1 },
    });
    expect(parsed).toMatchObject({ ok: true, bet: { stake: 1, data: null } });
  });

  it.each([
    "Data: 27/09\nHorário: 16:00",
    "Horário: 16:00\nData: 27/09",
    "📅 27/09\nHorário: 16:00",
    "📅 27/09 | ⏰ 16:00",
    "Data: 27/09 às 16:00hs",
  ])("data e hora do tipster, na mesma linha ou em rótulos separados: %j", (when) => {
    const parsed = readRule(`${JOGO}${when}\nEntrada: Flamengo ML\n@1.90\n1u`);
    expect(parsed).toMatchObject({ ok: true, bet: { data: new Date("2026-09-27T19:00:00.000Z"), kickoffDateOnly: false } });
  });

  it("data com ponto que não é linha de total continua lida", () => {
    const parsed = readRule(`${JOGO}24.9 20h\nEntrada: Over 2.5\n@1.90\n1u`);
    expect(parsed.ok && parsed.bet.data?.toISOString()).toBe("2026-09-24T23:00:00.000Z");
  });

  it("data de verdade continua lida", () => {
    const parsed = readRule(`${JOGO}18/10 16:00\nEntrada: Over 2.5\n@1.90\n1u`);
    expect(parsed.ok && parsed.bet.data?.toISOString()).toBe("2026-10-18T19:00:00.000Z");
  });
});

describe("da captura à liquidação pelo placar (regra → guard → normalização → placar)", () => {
  const client = productionMarketCatalogClient();
  async function capture(text: string) {
    const parsed = readRule(text);
    if (!parsed.ok) return { refused: `missing:${parsed.missing.join(",")}` } as const;
    const guarded = finalizeParsedBetForCapture(parsed.bet, text, "AUTO");
    if (!guarded.ok) return { refused: guarded.reason } as const;
    const bet = guarded.bet;
    const normalized = await normalizeBetFields({ evento: bet.evento, mercado: bet.mercado, selecao: bet.selecao, esporte: "Soccer", client });
    const settle = (homeScore: number, awayScore: number, scorePeriod?: "HT" | "FT") => {
      const result = resolveResultFromScore({
        ...normalized, esporte: "Soccer", odds: bet.odds, stake: bet.stake, homeScore, awayScore, scorePeriod,
        liveScoreHome: bet.liveScoreHome, liveScoreAway: bet.liveScoreAway,
      });
      return result.ok ? result.status : `recusa:${result.reason}`;
    };
    return { bet, normalized, settle } as const;
  }
  /** Captura que precisa gravar: a recusa aqui é falha do teste. */
  async function captured(text: string) {
    const r = await capture(text);
    if ("refused" in r) throw new Error(r.refused);
    return r;
  }

  it("'Flamengo over 1.5 gols' liquida pelos gols do Flamengo", async () => {
    const r = await captured(`${JOGO}Entrada: Flamengo over 1.5 gols\n@1.90\n1u`);
    expect(r.normalized.mercado).toBe("Team Total – Match");
    expect(r.settle(1, 1)).toBe("LOST");
    expect(r.settle(2, 0)).toBe("WON");
  });

  it("'Mercado: Gols - 1º tempo / Over 0.5' liquida pelo placar do intervalo", async () => {
    const r = await captured(`${JOGO}Mercado: Gols - 1º tempo\nEntrada: Over 0.5\n@1.90\n1u`);
    expect(r.settle(2, 1)).toBe("recusa:wrong_period");
    expect(r.settle(0, 0, "HT")).toBe("LOST");
  });

  it("handicap europeu não liquida como asiático", async () => {
    const r = await captured(`${JOGO}Entrada: Flamengo -1 (Handicap Europeu)\n@1.90\n1u`);
    expect(r.settle(1, 0)).toBe("recusa:unsupported_market");
  });

  it("'AO VIVO 1x0 / Flamengo -0.5' liquida pelo restante", async () => {
    const r = await captured(`AO VIVO 1x0\n${JOGO}Entrada: Flamengo -0.5\n@1.90\n1u`);
    expect(r.bet).toMatchObject({ liveScoreHome: 1, liveScoreAway: 0 });
    expect(r.settle(1, 0)).toBe("LOST");
    expect(r.settle(2, 0)).toBe("WON");
  });

  it.each([
    ["🔴 AO VIVO sem placar", `🔴 AO VIVO\n${JOGO}Entrada: Flamengo -0.5\n@1.90\n1u`, "placar_ao_vivo_ausente"],
    ["odd sem o ponto", `${JOGO}Entrada: Flamengo ML\n@185\n5u`, "odd_implausivel"],
    ["'Palmeiras não perde'", `${JOGO}Entrada: Palmeiras não perde\n@1.90\n1u`, "missing:mercado"],
    ["dupla", "🔥 DUPLA\nJogo: Flamengo x Palmeiras\nEntrada: Flamengo vence\nJogo: Santos x Grêmio\nEntrada: Over 2.5 gols\nOdd: 3.50\nStake: 1u", "missing:multipla"],
    ["'Valor: 50'", `${JOGO}Entrada: Flamengo ML\nOdd: 1.90\nValor: 50`, "missing:stake"],
    ["'Handicap' com linha inteira", `⚽ ${JOGO}Mercado: Handicap\nEntrada: Flamengo -1\n@1.90\n1u`, "handicap_tipo_ambiguo"],
  ])("%s não grava", async (_caso, text, refused) => {
    expect(await capture(text)).toEqual({ refused });
  });

  it("'Flamengo -0/0.5' num 1x1 é meia derrota", async () => {
    const r = await captured(`${JOGO}Entrada: Flamengo -0/0.5\n@1.90\n1u`);
    expect(r.settle(1, 1)).toBe("HALF_LOST");
  });
});


describe("ofertas promocionais não são stake", () => {
  it.each(["Bônus: 10u", "Cashback: 5u", "Ganhe 10u de bônus", "Ganhe 5u em freebets"])("lê a stake real após %s", (offer) => {
    const result = parseUniversalBetPost(`Flamengo vs Palmeiras\nEntrada: Flamengo\n@1.85\n${offer}\n1u`, { now: NOW });
    expect(result).toMatchObject({ ok: true, bet: { stake: 1 } });
  });
});
