import { describe, expect, it } from "vitest";
import samples from "../fixtures/player-props/flashscore-measured-20260908.json";
import examples from "../fixtures/player-props/igux-examples.json";
import ganso from "../fixtures/player-props/ganso-three-singles.json";
import vision from "../fixtures/player-props/vision-measured-20260908.json";
import {
  playerStatCount,
  normalizeFlashscorePlayers,
  flashscorePlayerStatsResponseSchema,
} from "@/src/providers/flashscore/player-stats";
import {
  flashscoreLineupsSchema,
  normalizePlayerAppearances,
  mergePlayerAppearances,
} from "@/src/providers/flashscore/lineups";
import { preparePlayerCaptureBatch, playerCaptureItemKey } from "@/src/domain/player-prop-capture";

describe("identidade da simples tolera apenas separadores equivalentes", () => {
  const item = { evento: "Napoli vs Arsenal", esporte: "Soccer", mercado: "Player Shots", selecao: "Matteo Politano Over 1.5" };
  it.each(["Napoli - Arsenal", "Napoli – Arsenal", "Napoli — Arsenal", "Napoli x Arsenal", "Napoli versus Arsenal"])("reconhece %s", (evento) => {
    expect(playerCaptureItemKey({ ...item, evento })).toBe(playerCaptureItemKey(item));
  });
  it("preserva ordem, adversário, jogador, linha e qualificador", () => {
    for (const change of [{ evento: "Arsenal vs Napoli" }, { evento: "Napoli vs Arsenal U21" }, { evento: "Napoli vs Chelsea" }, { selecao: "Giovanni Politano Over 1.5" }, { selecao: "Matteo Politano Under 1.5" }, { selecao: "Matteo Politano Over 2.5" }, { mercado: "Player Shots on Target" }]) {
      expect(playerCaptureItemKey({ ...item, ...change })).not.toBe(playerCaptureItemKey(item));
    }
  });
});
import {
  buildPlayerPropTerms,
  normalizePlayerThreshold,
} from "@/src/domain/settlement/player-prop-terms";
import { playerPropRule, decidePlayerProp } from "@/src/domain/settlement/player-prop-rules";
import { classificarPropDeJogador } from "@/src/domain/settlement/player-prop-classify";
import type { ParsedBetPost } from "@/src/domain/bet-capture";
import { mapLlmBetToParsedList } from "@/src/services/capture/reading/extraction-mapping";

describe("props: exemplos reais e limites financeiros", () => {
  it("a leitura real dos oito prints preserva as 16 simples, nomes, mercados, linhas, odds e stakes", () => {
    const expected = [...examples, ganso];
    let units = 0;
    for (let i = 0; i < vision.length; i++) {
      const mapped = mapLlmBetToParsedList(vision[i]!.data, new Date("2026-09-08T12:00:00Z"));
      expect(mapped, `print ${i + 1}`).not.toBeNull();
      const prepared = preparePlayerCaptureBatch(mapped!, expected[i]!.caption, true);
      expect(prepared.ok, `print ${i + 1}`).toBe(true);
      if (!prepared.ok) throw new Error(prepared.reason);
      const shape = (b: ParsedBetPost) => { const terms = buildPlayerPropTerms(b); return [terms?.jogador, terms?.family, terms?.direction, terms?.lineQuarters, b.odds, b.stake]; };
      expect(prepared.bets.map(shape), `print ${i + 1}`).toEqual((expected[i]!.items as ParsedBetPost[]).map(shape));
      units += prepared.bets.reduce((sum, b) => sum + b.stake, 0);
    }
    expect(units).toBe(13.75);
  });
  it("o bilhete de Ganso contém três simples de estatísticas/linhas diferentes", () => {
    const result = preparePlayerCaptureBatch(ganso.items as ParsedBetPost[], "", true);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.bets.map((bet) => [buildPlayerPropTerms(bet)?.family, bet.odds, bet.stake])).toEqual([
      ["shots_on_target", 3.8, 1], ["shots_total", 1.89, 2], ["shots_total", 5.1, 0.5],
    ]);
    expect(new Set(result.bets.map(playerCaptureItemKey)).size).toBe(3);
    expect(result.bets.every((bet) => !bet.legs)).toBe(true);
  });
  it("preserva as 13 seleções e suas 10,25u", () => {
    const out = examples.flatMap((post) => {
      const result = preparePlayerCaptureBatch(post.items as ParsedBetPost[], post.caption, true);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.reason);
      expect(result.bets.map((b) => [b.odds, b.stake])).toEqual(post.items.map((b) => [b.odds, b.stake]));
      return result.bets;
    });
    expect(out).toHaveLength(13);
    expect(out.reduce((sum, b) => sum + b.stake, 0)).toBe(10.25);
    expect(out[1]?.selecao).toBe("Tom Fellows Over 1.5");
    expect(out[10]?.selecao).toBe("Ayyoub Bouaddi Over 2.5");
  });
  it("a convenção monetária do print só vale para o grupo configurado", () => {
    expect(preparePlayerCaptureBatch(examples[0]!.items as ParsedBetPost[], "", false).ok).toBe(false);
    expect(preparePlayerCaptureBatch(examples[1]!.items as ParsedBetPost[], "1.25u", true)).toEqual({ ok: false, reason: "quantidade_de_stakes_divergente" });
  });
  it("um item inválido nunca desaparece de um lote parcialmente válido", () => {
    const items = examples[1]!.items;
    expect(mapLlmBetToParsedList({ isBet: true, ...items[0], items: [items[0], { ...items[1], odds: 0 }] }, new Date())).toBeNull();
  });
  it("ordem visual não muda a chave; jogador, linha e estatística mudam", () => {
    const item = examples[1]!.items[0]!;
    expect(playerCaptureItemKey(item)).toBe(playerCaptureItemKey({ ...item, selecao: normalizePlayerThreshold(item.selecao) }));
    expect(playerCaptureItemKey(item)).not.toBe(playerCaptureItemKey(examples[1]!.items[1]!));
  });
  it.each(["", " ", "-1", "0.7", "2.8", "30%", "0x10", null, undefined, NaN, Infinity])("recusa contagem inválida %s", (value) => expect(playerStatCount(value)).toBeUndefined());
  it.each([0, "0", "2", "2.0"])("aceita contagem inteira %s", (value) => expect(playerStatCount(value)).toBe(Number(value)));
  it("ausência de cobertura medida como [] não é falha da API", () => expect(flashscorePlayerStatsResponseSchema.parse([])).toEqual({ players: [] }));
  it.each([
    ["Remates do jogador", "shots_total"], ["Remates à baliza do jogador", "shots_on_target"],
    ["Player Tackles Won", "tackles_won"], ["Player Passes Completed", "passes_completed"],
    ["Player Yellow Cards", "cards_yellow"], ["Player Red Cards", "cards_red"],
    ["Player Tackles ganhos", "tackles_won"], ["Player Passes certos", "passes_completed"],
  ])("preserva qualificador %s", (mercado, family) => expect(classificarPropDeJogador({ mercado, selecao: "Tom Fellows Over 1.5", esporte: "Soccer" })).toMatchObject({ family }));
});

describe("Flashscore: contrato medido em quatro competições", () => {
  it.each(samples)("valida o payload de $match.match_id", (sample) => {
    const players = normalizeFlashscorePlayers(flashscorePlayerStatsResponseSchema.parse(sample.payload));
    expect(players.length).toBeGreaterThan(20);
    expect(players.every((p) => p.teamId)).toBe(true);
    for (const p of players) {
      const stats = p.stats ?? {};
      expect((stats.SHOTS_ON_TARGET ?? 0)).toBeLessThanOrEqual(stats.SHOTS_TOTAL ?? 0);
      expect((stats.TACKLES_WON ?? 0)).toBeLessThanOrEqual(stats.TACKLES_TOTAL ?? 0);
      expect((stats.PASSES_ACCURATE ?? 0)).toBeLessThanOrEqual(stats.PASSES_TOTAL ?? 0);
    }
  });
  it("escalação confirmada comprova entrada nos acréscimos sem inventar contagem", () => {
    const sample = samples.find((s) => "lineups" in s)!;
    const lineups = flashscoreLineupsSchema.parse(sample.lineups);
    const appearances = normalizePlayerAppearances(lineups, { home: "h", away: "a" });
    expect(appearances.filter((p) => p.titular)).toHaveLength(22);
    expect(appearances.some((p) => !p.titular && p.participou)).toBe(true);
    expect(mergePlayerAppearances([], appearances).every((p) => p.stats?.SHOTS_TOTAL === undefined)).toBe(true);
    expect(normalizePlayerAppearances([{ side: "home", predictedLineups: [{ player_id: "1", name: "Fulano" }] }], { home: "h", away: "a" })).toEqual([]);
  });
});

describe("regra da casa e resultado da prop", () => {
  const terms = buildPlayerPropTerms({ mercado: "Player Shots", selecao: "Tom Fellows 2+", esporte: "Soccer" })!;
  const player = { playerId: "tf", nome: "Tom Fellows", gols: 0, golsContra: 0, titular: true, participou: true, substituido: false, stats: { SHOTS_TOTAL: 2 } };
  const base = { terms, player, rule: playerPropRule("Bet365", "shots_total"), extraTime: false, verifiedKeys: ["SHOTS_TOTAL"], preMatch: true };
  it("2+ com dois chutes vence", () => expect(decidePlayerProp(base)).toMatchObject({ ok: true, status: "WON" }));
  it("não titular anula mesmo se entrou e atingiu a linha", () => expect(decidePlayerProp({ ...base, player: { ...player, titular: false } })).toMatchObject({ ok: true, status: "VOID" }));
  it("substituição com impacto possível exige conferência", () => expect(decidePlayerProp({ ...base, player: { ...player, substituido: true } })).toMatchObject({ ok: false, reason: "regra_de_substituicao_pendente" }));
  it("Bet365 permite prorrogação; KTO não usa esse agregado", () => {
    expect(decidePlayerProp({ ...base, extraTime: true }).ok).toBe(true);
    expect(decidePlayerProp({ ...base, extraTime: true, rule: playerPropRule("KTO", "shots_total") })).toMatchObject({ ok: false, reason: "estatistica_de_90_minutos_indisponivel" });
  });
  it("zero ausente difere de zero publicado e participação é obrigatória", () => {
    expect(decidePlayerProp({ ...base, player: { ...player, stats: {} } })).toMatchObject({ ok: false, reason: "stat_ausente" });
    expect(decidePlayerProp({ ...base, player: { ...player, stats: { SHOTS_TOTAL: 0 } } })).toMatchObject({ ok: true, status: "LOST" });
    expect(decidePlayerProp({ ...base, player: { ...player, participou: false, stats: { SHOTS_TOTAL: 0 } } })).toMatchObject({ ok: false, reason: "participacao_nao_comprovada" });
  });
  it("combinações e percentuais permanecem sem liquidação automática", () => {
    const mixed = buildPlayerPropTerms({ mercado: "Player Shots & Assists", selecao: "Tom Fellows Over 2.5", esporte: "Soccer" })!;
    expect(decidePlayerProp({ ...base, terms: mixed })).toMatchObject({ ok: false, reason: "qualificador_ou_combinacao_sem_contrato" });
    expect(decidePlayerProp({ ...base, competition: "Kings League" })).toMatchObject({ ok: false, reason: "regra_da_competicao_nao_comprovada" });
  });
  it("gol ou assistência é combinação: o mercado não vira só assistência", () => {
    const terms = (mercado: string) => buildPlayerPropTerms({
      mercado, selecao: "Franco Cristaldo", esporte: "Soccer",
      playerProp: { jogador: "Franco Cristaldo", mercadoOriginal: mercado, selecaoOriginal: "Franco Cristaldo" },
    });
    for (const mercado of ["Para Marcar ou Dar Assistência", "Marcar ou Dar Assistência"]) {
      expect(terms(mercado), mercado).toMatchObject({ family: "assists", unsupportedReason: "qualificador_ou_combinacao_sem_contrato" });
    }
    for (const mercado of [
      "Assistência", "Assistências Mais ou Menos", "Player Assists Over or Under",
      "Jogador - Total de assistências - Acima ou Abaixo", "Assistências Abaixo ou Acima", "Player Assists Above or Below",
    ]) {
      expect(terms(mercado), mercado).toMatchObject({ family: "assists" });
      expect(terms(mercado)?.unsupportedReason, mercado).toBeUndefined();
    }
  });
});


describe("qualificadores da seleção no contrato da prop", () => {
  it.each(["Tom Fellows Over 1.5%", "Tom Fellows Over 1.5 & Win"])(
    "preserva a recusa ao capturar e ao ler contrato já gravado: %s", (selecao) => {
      const terms = buildPlayerPropTerms({ mercado: "Player Shots", selecao, esporte: "Soccer" })!;
      expect(terms.unsupportedReason).toBe("qualificador_ou_combinacao_sem_contrato");
      const { unsupportedReason: _reason, ...stored } = terms;
      expect(decidePlayerProp({ terms: stored, rule: playerPropRule("Bet365", "shots_total"),
        player: { playerId: "tom", nome: "Tom Fellows", gols: 0, golsContra: 0, titular: true,
          participou: true, substituido: false, stats: { SHOTS_TOTAL: 2 } },
        preMatch: true, extraTime: false, verifiedKeys: ["SHOTS_TOTAL"] }))
        .toMatchObject({ ok: false, reason: "qualificador_ou_combinacao_sem_contrato" });
    });
});
