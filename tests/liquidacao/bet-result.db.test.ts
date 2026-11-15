import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { applyManualBetStatusChange } from "../helpers/settle";
import { resetEnvCacheForTests } from "@/src/infra/env";
import { applyBetEdit } from "@/src/services/bets/edit";
import { writeScoreOnce } from "@/src/services/settlement/bet-result";
import { persistFlashscoreObservation } from "@/src/services/settlement/flashscore/observation-store";
import { settleFromFlashscoreScore } from "@/src/services/settlement/flashscore/score-settle";
import { resolveProvisionalKickoff } from "@/src/services/sharp/enrich/kickoff-provisional";
import { linkEarlyFlashscoreMatch } from "@/src/services/sharp/enrich/resolve-kickoff-flashscore";

/**
 * O resultado externo mora em `bet_result`: cada escritor grava lá, e nenhum
 * cria nem muda o resultado de `bet_closing`. Postgres real.
 */

let db: TestDb;
const KICKOFF = new Date("2026-09-20T18:00:00Z");

beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); });

async function bet(tag: string) {
  const bankroll = await db.prisma.bankroll.upsert({
    where: { slug: "resultado" }, create: { nome: "Resultado", slug: "resultado" }, update: {},
  });
  return db.prisma.bet.create({ data: {
    bankrollId: bankroll.id, data: KICKOFF, evento: `Alpha ${tag} vs Beta`, esporte: "Soccer",
    mercado: "Moneyline", selecao: "Alpha", odds: 2, stake: 1, status: "PENDING",
    sportResolutionStatus: "CONFIRMED", sportResolvedAt: KICKOFF, kickoffInferido: false,
    source: "test", sourceExternalId: `resultado-${tag}`,
  } });
}

const betResult = (betId: string) => db.prisma.betResult.findUniqueOrThrow({ where: { betId } });
const noClosing = async (betId: string) => expect(await db.prisma.betClosing.count({ where: { betId } })).toBe(0);
const eligible = (id: string) => db.prisma.bet.findUniqueOrThrow({
  where: { id }, include: { sharp: true, closing: true, result: true, captureEvidence: true },
});

async function withFlashscoreOn(run: () => Promise<void>): Promise<void> {
  const before = { mode: process.env.FLASHSCORE_MODE, key: process.env.FLASHSCORE_API_KEY };
  process.env.FLASHSCORE_MODE = "on";
  process.env.FLASHSCORE_API_KEY = "chave-de-teste";
  resetEnvCacheForTests();
  try {
    await run();
  } finally {
    for (const [key, value] of [["FLASHSCORE_MODE", before.mode], ["FLASHSCORE_API_KEY", before.key]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEnvCacheForTests();
  }
}

const linkFields = (b: { id: string; evento: string; data: Date }, kickoffInferido: boolean) => ({
  id: b.id, evento: b.evento, esporte: "Soccer", pais: "", competicao: "", data: b.data, kickoffInferido,
});

describe("escritores do resultado", () => {
  it("a observação do FlashScore grava em bet_result, sem criar bet_closing", async () => {
    const { id } = await bet("obs");
    const terms = await db.prisma.bet.findUniqueOrThrow({ where: { id } });
    await persistFlashscoreObservation({ bet: terms, checkedAt: KICKOFF, matchId: "fs-1", confidence: 0.97,
      final: true, snapshot: { outcome: "matched", placar: "2-1" } });
    expect(await betResult(id)).toMatchObject({ resultProvider: "flashscore", resultMatchId: "fs-1",
      resultCheckedAt: KICKOFF, resultFinal: true, resultSnapshot: { outcome: "matched", placar: "2-1" } });
    await noClosing(id);
  });

  it("a reabertura limpa o resultado", async () => {
    const { id } = await bet("reabre");
    await db.prisma.betResult.create({ data: { betId: id, scoreHome: 2, scoreAway: 1, resultProvider: "flashscore",
      resultMatchId: "fs-2", resultFinal: true, resultCheckedAt: KICKOFF, resultSnapshot: { placar: "2-1" } } });
    await applyManualBetStatusChange({ betId: id, newStatus: "WON", source: "test" });
    await applyManualBetStatusChange({ betId: id, newStatus: "PENDING", source: "test" });
    expect(await betResult(id)).toMatchObject({ scoreHome: null, scoreAway: null, resultProvider: null,
      resultMatchId: null, resultSnapshot: null, resultCheckedAt: null, resultFinal: false });
  });

  it("o placar é gravado uma vez só, e nunca para aposta removida", async () => {
    const { id } = await bet("placar");
    expect(await writeScoreOnce(id, { scoreHome: 2, scoreAway: 1 })).toBe(true);
    expect(await writeScoreOnce(id, { scoreHome: 0, scoreAway: 0 })).toBe(false);
    expect(await betResult(id)).toMatchObject({ scoreHome: 2, scoreAway: 1 });
    await noClosing(id);

    const removida = await bet("removida");
    await db.prisma.bet.update({ where: { id: removida.id }, data: { deletedAt: KICKOFF } });
    expect(await writeScoreOnce(removida.id, { scoreHome: 1, scoreAway: 0 })).toBe(false);
    expect(await db.prisma.betResult.count({ where: { betId: removida.id } })).toBe(0);
  });

  it("com requireNotPending, o placar só entra com a aposta liquidada", async () => {
    const { id } = await bet("liquidada");
    expect(await writeScoreOnce(id, { scoreHome: 1, scoreAway: 0 }, { requireNotPending: true })).toBe(false);
    await applyManualBetStatusChange({ betId: id, newStatus: "WON", source: "test" });
    expect(await writeScoreOnce(id, { scoreHome: 1, scoreAway: 0 }, { requireNotPending: true })).toBe(true);
  });

  it("placar que chega depois da liquidação manual feita entre a leitura e a escrita", async () => {
    const { id } = await bet("manual");
    const lida = await eligible(id);
    await applyManualBetStatusChange({ betId: id, newStatus: "LOST", source: "test" });

    await expect(settleFromFlashscoreScore(lida, { homeScore: 2, awayScore: 1 })).resolves.toBe(false);

    expect(await betResult(id)).toMatchObject({ scoreHome: 2, scoreAway: 1 });
    await noClosing(id);
  });

  it("placar guardado como evidência de mercado sem motor de placar", async () => {
    const { id } = await bet("evidencia");
    await db.prisma.bet.update({ where: { id }, data: { esporte: "Basketball", mercado: "Puck Line", selecao: "Alpha -1.5" } });

    await expect(settleFromFlashscoreScore(await eligible(id), { homeScore: 100, awayScore: 90 })).resolves.toBe(false);

    expect(await betResult(id)).toMatchObject({ scoreHome: 100, scoreAway: 90 });
    await noClosing(id);
  });

  it("a edição estrutural apaga o resultado e o fechamento", async () => {
    const { id } = await bet("estrutural");
    await db.prisma.betSharp.create({ data: { betId: id, identityStatus: "MATCHED", confidence: 95 } });
    await db.prisma.betClosing.create({ data: { betId: id, closingOdd: 1.9, clvReliable: true, fetchedAt: KICKOFF } });
    await db.prisma.betResult.create({ data: { betId: id, resultProvider: "flashscore", resultMatchId: "fs-e1",
      resultCheckedAt: KICKOFF, resultSnapshot: { placar: "1-0" } } });

    await applyBetEdit({ betId: id, actor: "test", fields: {
      data: KICKOFF, evento: "Gamma vs Delta", esporte: "Soccer", competicao: "", pais: "",
      mercado: "Moneyline", selecao: "Gamma", odds: 2, stake: 1,
    } });

    await noClosing(id);
    expect(await db.prisma.betResult.count({ where: { betId: id } })).toBe(0);
  });

  it("a edição que mantém o jogo limpa a leitura do resultado e guarda o jogo vinculado", async () => {
    const { id } = await bet("mantem");
    const created = await db.prisma.bet.update({ where: { id }, data: { mercado: "Handicap – Match", selecao: "Beta +0.25" } });
    await db.prisma.betSharp.create({ data: { betId: created.id, identityStatus: "MATCHED", confidence: 95 } });
    await db.prisma.betResult.create({ data: { betId: created.id, resultProvider: "flashscore", resultMatchId: "fs-e2",
      resultCheckedAt: KICKOFF, resultSnapshot: { placar: "1-0" } } });

    // O primeiro placar ao vivo reabre a aposta sem trocar a identidade.
    await expect(applyBetEdit({ betId: created.id, actor: "telegram-edit", fields: {
      data: KICKOFF, evento: created.evento, esporte: "Soccer", competicao: "", pais: "",
      mercado: "Handicap – Match", selecao: "(1-0) Beta +0.25", odds: 2, stake: 1,
    } })).resolves.toMatchObject({ identityPreserved: true, settlementPreserved: false });

    expect(await betResult(created.id)).toMatchObject({ resultProvider: "flashscore", resultMatchId: "fs-e2",
      resultSnapshot: null, resultCheckedAt: null, resultFinal: false });
  });
});

describe("vínculo antecipado do FlashScore no enrich", () => {
  const scheduled = new Date("2026-09-20T20:00:00Z");
  const fromFlashscore = async () => ({ kickoff: scheduled, sport: "Soccer", confidence: 1, country: null, competition: null, matchId: "fs-prov" });

  it("o horário pelo calendário do FlashScore grava o jogo em bet_result, sem criar bet_closing", async () => {
    const created = await bet("prov");
    const b = await db.prisma.bet.update({ where: { id: created.id }, data: { kickoffInferido: true } });
    await resolveProvisionalKickoff(linkFields(b, true), { flashscoreSchedule: fromFlashscore, pinnacle17Schedule: async () => null });

    expect(await betResult(b.id)).toMatchObject({ resultProvider: "flashscore", resultMatchId: "fs-prov" });
    await noClosing(b.id);
  });

  it.each(["editada", "restaurada", "removida", "vinculada", "identificada"] as const)("a busca atrasada não grava um vínculo na aposta %s durante a consulta", async (change) => {
    const b = await bet(`atrasada-${change}`);
    let changed = false;
    await withFlashscoreOn(() => linkEarlyFlashscoreMatch(linkFields(b, false), { findFlashscoreMatchId: async () => {
      if (change === "editada" || change === "restaurada") await applyBetEdit({ betId: b.id, actor: "teste", fields: {
        data: b.data, evento: "Outra Casa vs Outro Fora", esporte: b.esporte, mercado: b.mercado,
        selecao: "Over 2.5", odds: 2, stake: 1, competicao: "", pais: "",
      } });
      if (change === "restaurada") await applyBetEdit({ betId: b.id, actor: "teste", fields: {
        data: b.data, evento: b.evento, esporte: b.esporte, mercado: b.mercado,
        selecao: b.selecao, odds: Number(b.odds), stake: Number(b.stake), competicao: b.competicao, pais: b.pais,
      } });
      if (change === "removida") await db.prisma.bet.update({ where: { id: b.id }, data: { deletedAt: new Date() } });
      if (change === "vinculada") await db.prisma.betResult.create({ data: { betId: b.id,
        resultProvider: "flashscore", resultMatchId: "fs-atual", resultFinal: true, scoreHome: 1, scoreAway: 0 } });
      if (change === "identificada") await db.prisma.betSharp.create({ data: { betId: b.id,
        identityStatus: "MANUAL", provider: "bridgeodds", providerMatchId: "outro-evento", confidence: 100 } });
      changed = true;
      return "fs-antigo";
    } }));
    expect(changed).toBe(true);
    const result = await db.prisma.betResult.findUnique({ where: { betId: b.id } });
    if (change === "vinculada") expect(result).toMatchObject({ resultMatchId: "fs-atual", resultFinal: true, scoreHome: 1 });
    else expect(result).toBeNull();
  });

  it("o vínculo do enrich grava o jogo em bet_result, sem criar bet_closing", async () => {
    const b = await bet("link");
    await withFlashscoreOn(() => linkEarlyFlashscoreMatch(linkFields(b, false), { findFlashscoreMatchId: async () => "fs-link" }));

    expect(await betResult(b.id)).toMatchObject({ resultProvider: "flashscore", resultMatchId: "fs-link" });
    await noClosing(b.id);
  });
});

it("bet_result recusa confiança do vínculo fora de 0 a 1", async () => {
  const { id } = await bet("confianca");
  await expect(db.prisma.betResult.create({ data: { betId: id, resultMatchConfidence: 1.5 } }))
    .rejects.toThrow(/bet_result_result_match_confidence_check/);
});
