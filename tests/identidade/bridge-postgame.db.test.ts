import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { POSTGAME_MAX_ATTEMPTS, runBridgePostgameOnce } from "@/src/services/sharp/bridge-postgame";
import { applyBetEdit } from "@/src/services/bets/edit";
import { ProviderRequestError } from "@/src/domain/provider-error";
import { clearBridgeCatalogCache } from "@/src/providers/bridgeodds/catalog";
import type { BridgeQueryPage } from "@/src/providers/bridgeodds/types";
import { getBetDetail } from "@/src/services/painel/queries/bet-rows";
import { toNumber } from "@/src/domain/money";
import type { BetStatus } from "@/src/generated/prisma/client";

/**
 * Busca pós-jogo na BridgeOdds: uma consulta por aposta grava a abertura e o
 * fechamento que falta, de 35 min depois do kickoff até 25 dias. Fixture
 * Birmingham Legion (jogo terminado, com abertura e fechamento).
 */
const page = JSON.parse(
  readFileSync(new URL("../fixtures/bridgeodds/opening-closing-page.json", import.meta.url), "utf8"),
) as BridgeQueryPage;
const birmingham = page.results.find(
  (m) => m.home === "Birmingham Legion" && m.home_score === 3,
)!;

const fakeQuery = async () => [birmingham];
const KICKOFF = new Date(birmingham.match_date);
const NOW = new Date(KICKOFF.getTime() + 3 * 3_600_000);

let db: TestDb;

beforeAll(() => {
  db = createTestDb();
});

afterAll(async () => {
  await db.dispose();
});

beforeEach(async () => {
  await db.reset();
});

async function seedScenario(params?: {
  status?: BetStatus;
  identityStatus?: "MATCHED" | "MANUAL";
  kickoffDate?: Date;
  hasClosingRecord?: boolean;
  noOddsReason?: string | null;
  closingOdd?: number | null;
  registradoEm?: Date;
  liveScoreHome?: number | null;
  liveScoreAway?: number | null;
  provider?: "bridgeodds" | "pinnacle17";
  mercado?: string;
  ext?: string;
}) {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: "Big Data", slug: `big-data-${params?.ext ?? "a"}`, valorUnidade: 100, sharpMode: "CLV_ONLY" },
  });
  const kickoff = params?.kickoffDate ?? KICKOFF;
  const bet = await db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      settledAt: (params?.status ?? "WON") === "PENDING" ? null : kickoff,
      bankrollId: bankroll.id,
      data: kickoff,
      evento: "Birmingham Legion vs Corpus Christi",
      esporte: "Soccer",
      competicao: "USL Cup",
      pais: "USA",
      mercado: params?.mercado ?? "Money Line – Match",
      selecao: "Birmingham Legion",
      odds: 1.5,
      stake: 1,
      status: params?.status ?? "WON",
      source: "test",
      sourceExternalId: `postgame-${params?.ext ?? "a"}`,
      registradoEm: params?.registradoEm ?? new Date(kickoff.getTime() - 3_600_000),
      liveScoreHome: params?.liveScoreHome,
      liveScoreAway: params?.liveScoreAway,
      sharp: {
        create: {
          identityStatus: params?.identityStatus ?? "MATCHED",
          provider: params?.provider ?? "bridgeodds",
          providerMatchId: String(birmingham.match_id),
          confidence: 90,
        },
      },
    },
  });
  if (params?.hasClosingRecord) {
    await db.prisma.betClosing.create({
      data: {
        betId: bet.id,
        clvReliable: false,
        noOddsReason: params.noOddsReason ?? "kickoff_sem_captura",
        closingOdd: params.closingOdd ?? null,
        fetchedAt: new Date(kickoff.getTime() + 5 * 60_000),
        source: "CRON",
      },
    });
  }
  return { bankroll, bet };
}

const closingOf = (betId: string) => db.prisma.betClosing.findUniqueOrThrow({ where: { betId } });
const openingOf = (betId: string) => db.prisma.betOpening.findUniqueOrThrow({ where: { betId } });

describe("uma consulta, abertura e fechamento", () => {
  it.each([[499.75, 1_150.25], [1_000.75, 1_150.75], [0.75, 0.85]])("limites fracionários mantêm o valor exato na ficha (%s → %s)", async (opening, closing) => {
    const { bet } = await seedScenario();
    const match = structuredClone(birmingham);
    match.moneyline!.opening!.max_bet = opening;
    match.moneyline!.closing!.max_bet = closing;
    expect(await runBridgePostgameOnce({ query: async () => [match], now: NOW }))
      .toMatchObject({ openings: 1, closings: 1, failures: 0 });
    const row = (await getBetDetail(bet.id))!;
    expect(row.openingMaxBet).toBe(opening);
    expect(row.closingMaxBet).toBe(closing);
  });

  it("grava a abertura e o fechamento da mesma resposta", async () => {
    const { bet } = await seedScenario();
    let consultas = 0;
    const result = await runBridgePostgameOnce({ query: async () => { consultas += 1; return [birmingham]; }, now: NOW });

    expect(result).toMatchObject({ checked: 1, openings: 1, closings: 1, missing: 0, failures: 0 });
    expect(consultas).toBe(1);
    const closing = await closingOf(bet.id);
    expect(closing).toMatchObject({ clvReliable: true, provider: "bridgeodds", source: "REPROCESS", noOddsReason: null });
    expect(toNumber(closing.closingOdd)).toBeGreaterThan(1);
    // Placar fica para o FlashScore liquidar.
    expect(await db.prisma.betResult.count({ where: { betId: bet.id } })).toBe(0);
    expect(await openingOf(bet.id)).toMatchObject({ provider: "bridgeodds", priceReference: `bridgeodds:v1:${birmingham.match_id}` });
    // Com tudo gravado, a próxima rodada não consulta de novo.
    expect((await runBridgePostgameOnce({ query: fakeQuery, now: NOW })).checked).toBe(0);
  });

  it("aposta da Pinnacle17 com CLV confiável busca só a abertura, sem tocar no fechamento", async () => {
    const { bet } = await seedScenario({ provider: "pinnacle17" });
    await db.prisma.betClosing.create({ data: {
      betId: bet.id, provider: "pinnacle17", closingOdd: 1.45, closingRawOdd: 1.47, clv: 3.4, clvReliable: true,
      closingPriceObservedAt: new Date(KICKOFF.getTime() - 60_000), fetchedAt: KICKOFF, source: "CRON",
    } });
    const result = await runBridgePostgameOnce({ query: fakeQuery, now: NOW });
    expect(result).toMatchObject({ checked: 1, openings: 1, closings: 0 });
    expect(await closingOf(bet.id)).toMatchObject({ provider: "pinnacle17", clvReliable: true });
    expect(Number((await openingOf(bet.id)).openingRawOdd)).toBe(1.406);
  });

  it("repesca aposta da Pinnacle17 na Bridge pelo mesmo id, mesmo sem o filtro do mandante", async () => {
    const { bet } = await seedScenario({ provider: "pinnacle17", hasClosingRecord: true });
    const result = await runBridgePostgameOnce({ query: async (params) => (params.filters ? [] : [birmingham]), now: NOW });
    expect(result).toMatchObject({ closings: 1, openings: 1 });
    expect(await closingOf(bet.id)).toMatchObject({ clvReliable: true, provider: "bridgeodds",
      closingPriceReference: `bridgeodds:v1:${birmingham.match_id}` });
  });

  it("id da Pinnacle17 com outro horário na Bridge não repesca nem cai na busca por nome", async () => {
    const { bet } = await seedScenario({ provider: "pinnacle17", hasClosingRecord: true,
      kickoffDate: new Date(KICKOFF.getTime() + 2 * 3_600_000) });
    const calls: unknown[] = [];
    const result = await runBridgePostgameOnce({ query: async (params) => { calls.push(params); return [birmingham]; },
      now: new Date(NOW.getTime() + 2 * 3_600_000) });
    expect(result).toMatchObject({ checked: 1, closings: 0, missing: 1 });
    expect(calls).toHaveLength(1);
    expect(await closingOf(bet.id)).toMatchObject({ closingOdd: null, noOddsReason: "kickoff_sem_captura" });
  });

  it("jogo remarcado na Bridge: antes do início real não grava, e o ponto seguinte da agenda fecha", async () => {
    const { bet } = await seedScenario();
    const remarcado = { ...birmingham, match_date: new Date(KICKOFF.getTime() + 3 * 3_600_000).toISOString() };
    const cedo = new Date(KICKOFF.getTime() + 60 * 60_000);
    expect(await runBridgePostgameOnce({ now: cedo, query: async () => [remarcado] }))
      .toMatchObject({ checked: 1, closings: 0, missing: 1 });
    expect(await db.prisma.betClosing.findUnique({ where: { betId: bet.id } })).toBeNull();
    const depois = new Date(KICKOFF.getTime() + 7 * 3_600_000);
    expect(await runBridgePostgameOnce({ now: depois, query: async () => [remarcado] })).toMatchObject({ closings: 1 });
    expect(await closingOf(bet.id)).toMatchObject({ clvReliable: true, closingPriceObservedAt: depois });
  });

  it("jogo que nunca começou na Bridge congela com motivo na última vez da agenda", async () => {
    const { bet } = await seedScenario();
    const now = new Date(KICKOFF.getTime() + 20 * 86_400_000 + 3_600_000);
    await db.prisma.betOpening.create({ data: { betId: bet.id, attempts: POSTGAME_MAX_ATTEMPTS - 1,
      lastAttemptAt: new Date(now.getTime() - 6 * 3_600_000) } });
    const adiado = { ...birmingham, match_date: new Date(now.getTime() + 86_400_000).toISOString() };
    expect(await runBridgePostgameOnce({ now, query: async () => [adiado] })).toMatchObject({ checked: 1, closings: 0, missing: 1 });
    expect(await closingOf(bet.id)).toMatchObject({ closingOdd: null, clvReliable: false, noOddsReason: "kickoff_sem_captura" });
  });

  it("fechamento real da Bridge substitui a cotação da Pinnacle17 sem CLV confiável", async () => {
    const { bet } = await seedScenario({ provider: "pinnacle17" });
    await db.prisma.betClosing.create({ data: {
      betId: bet.id, provider: "pinnacle17", closingOdd: 1.9, clv: -21, clvReliable: false,
      noOddsReason: "market_not_listed", closingPriceObservedAt: new Date(KICKOFF.getTime() - 40 * 60_000),
      fetchedAt: KICKOFF, source: "CRON",
    } });
    expect(await runBridgePostgameOnce({ query: fakeQuery, now: NOW })).toMatchObject({ closings: 1 });
    expect(await closingOf(bet.id)).toMatchObject({
      provider: "bridgeodds", clvReliable: true, noOddsReason: null, source: "REPROCESS", fetchedAt: KICKOFF,
    });
  });

  it("a cotação trocada durante a consulta não é pisada", async () => {
    const { bet } = await seedScenario({ provider: "pinnacle17" });
    const early = new Date(KICKOFF.getTime() - 40 * 60_000);
    await db.prisma.betClosing.create({ data: {
      betId: bet.id, provider: "pinnacle17", closingOdd: 1.9, clv: -21, clvReliable: false,
      noOddsReason: "closing_quote_too_early", closingPriceObservedAt: early, fetchedAt: KICKOFF, source: "CRON",
    } });
    const recovered = new Date(KICKOFF.getTime() - 2 * 60_000);
    const result = await runBridgePostgameOnce({
      now: NOW,
      query: async () => {
        // O arquivo de preços achou a cotação dos minutos finais nesse meio tempo.
        await db.prisma.betClosing.update({ where: { betId: bet.id }, data: {
          provider: "pinnacle17", closingOdd: 1.85, closingRawOdd: 1.9, clv: 1, closingPriceObservedAt: recovered,
          clvReliable: true, noOddsReason: null, source: "REPROCESS",
        } });
        return [birmingham];
      },
    });
    expect(result).toMatchObject({ closings: 0, missing: 0 });
    const row = await closingOf(bet.id);
    expect(row).toMatchObject({ provider: "pinnacle17", closingPriceObservedAt: recovered, clvReliable: true });
  });

  it("edição da odd durante a consulta não grava o CLV da odd antiga", async () => {
    const { bet } = await seedScenario({ hasClosingRecord: true });
    await runBridgePostgameOnce({
      query: async () => {
        await db.prisma.bet.update({ where: { id: bet.id }, data: { odds: 1.7 } });
        return [birmingham];
      },
      now: NOW,
    });
    expect(await closingOf(bet.id)).toMatchObject({ closingOdd: null, clv: null, clvReliable: false });
  });

  it("edição da seleção durante a consulta não grava a abertura nem o fechamento da linha antiga", async () => {
    const { bet } = await seedScenario();
    let editada = false;
    const result = await runBridgePostgameOnce({
      now: NOW,
      query: async () => {
        if (!editada) {
          editada = true;
          const { manualSettlementVersion } = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
          await applyBetEdit({ betId: bet.id, actor: "dono", financialAuthority: "operator", expectedVersion: manualSettlementVersion, fields: {
            data: bet.data, evento: bet.evento, esporte: bet.esporte, competicao: bet.competicao, pais: bet.pais,
            mercado: bet.mercado, selecao: "Corpus Christi", odds: 1.5, stake: 1 } });
        }
        return [birmingham];
      },
    });
    expect(result).toMatchObject({ checked: 1, openings: 0, closings: 0 });
    expect(await db.prisma.betOpening.findUnique({ where: { betId: bet.id } })).toBeNull();
    expect(await db.prisma.betClosing.findUnique({ where: { betId: bet.id } })).toBeNull();
    // O enrich casa o mesmo jogo de novo, e a rodada seguinte grava a linha da seleção nova.
    await db.prisma.betSharp.create({ data: { betId: bet.id, identityStatus: "MATCHED", provider: "bridgeodds",
      providerMatchId: String(birmingham.match_id), confidence: 90 } });
    expect(await runBridgePostgameOnce({ query: fakeQuery, now: NOW })).toMatchObject({ openings: 1, closings: 1 });
    const closing = await closingOf(bet.id);
    expect(closing.clvReliable).toBe(true);
    // O visitante fechou muito acima de 1.5: o CLV é o da seleção nova.
    expect(toNumber(closing.clv)).toBeLessThan(-50);
  });

  it("identidade manual também é repescada, e PENDING continua sem placar", async () => {
    const { bet } = await seedScenario({ identityStatus: "MANUAL", status: "PENDING", hasClosingRecord: true,
      noOddsReason: "sem_linha_atual" });
    expect(await runBridgePostgameOnce({ query: fakeQuery, now: NOW })).toMatchObject({ closings: 1 });
    const closing = await closingOf(bet.id);
    expect(closing.clvReliable).toBe(true);
    expect(await db.prisma.betResult.count({ where: { betId: bet.id } })).toBe(0);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).status).toBe("PENDING");
  });
});

describe("o que não é consultado", () => {
  it("antes de 35 min do kickoff não consulta: a última vez do closing.sync é aos 30", async () => {
    await seedScenario();
    let consultas = 0;
    const result = await runBridgePostgameOnce({ query: async () => { consultas += 1; return [birmingham]; },
      now: new Date(KICKOFF.getTime() + 32 * 60_000) });
    expect(result.checked).toBe(0);
    expect(consultas).toBe(0);
  });

  it("não processa kickoff fora da janela de 25 dias", async () => {
    await seedScenario({ kickoffDate: new Date(NOW.getTime() - 26 * 86_400_000) });
    expect((await runBridgePostgameOnce({ query: fakeQuery, now: NOW })).checked).toBe(0);
  });

  it("não reprocessa fechamento com preço", async () => {
    await seedScenario({ hasClosingRecord: true, noOddsReason: null, closingOdd: 1.4, mercado: "Total (Corners) – Match" });
    expect((await runBridgePostgameOnce({ query: fakeQuery, now: NOW })).checked).toBe(0);
  });

  it.each(["sharp_off", "clv_only", "unsupported_market", "missing_line", "ambiguous_selection"])(
    "motivo permanente no fechamento não é repescado: %s",
    async (noOddsReason) => {
      await seedScenario({ hasClosingRecord: true, noOddsReason, mercado: "Total (Corners) – Match" });
      expect((await runBridgePostgameOnce({ query: fakeQuery, now: NOW })).checked).toBe(0);
    },
  );

  it("mercado que a Bridge não cobre, casado pela Pinnacle17, fica de fora", async () => {
    await seedScenario({ provider: "pinnacle17", mercado: "Total (Corners) – Match" });
    expect((await runBridgePostgameOnce({ query: fakeQuery, now: NOW })).checked).toBe(0);
  });

  it("fechamento manual nunca é trocado", async () => {
    const { bet } = await seedScenario({ mercado: "Total (Corners) – Match" });
    await db.prisma.betClosing.create({ data: { betId: bet.id, source: "MANUAL", fetchedAt: KICKOFF } });
    expect((await runBridgePostgameOnce({ query: fakeQuery, now: NOW })).checked).toBe(0);
  });

  it("entrada ao vivo: marca o fechamento sem consultar, e a abertura segue", async () => {
    const { bet } = await seedScenario({ registradoEm: new Date(KICKOFF.getTime() + 30 * 60_000),
      liveScoreHome: 1, liveScoreAway: 0 });
    let consultas = 0;
    const result = await runBridgePostgameOnce({ now: NOW, query: async () => { consultas += 1; return [birmingham]; } });
    expect(result).toMatchObject({ checked: 1, openings: 1, closings: 0 });
    expect(consultas).toBe(1);
    expect(await closingOf(bet.id)).toMatchObject({ closingOdd: null, clv: null, clvReliable: false,
      noOddsReason: "aposta_ao_vivo", source: "REPROCESS" });
  });
});

describe("tentativas", () => {
  it("jogo que a Bridge não lista congela o fechamento com o motivo e volta no ponto seguinte da agenda", async () => {
    const { bet } = await seedScenario();
    expect(await runBridgePostgameOnce({ now: NOW, query: async () => [] })).toMatchObject({ checked: 1, missing: 1 });
    expect(await closingOf(bet.id)).toMatchObject({ closingOdd: null, clvReliable: false,
      noOddsReason: "partida_nao_localizada", source: "REPROCESS" });
    expect(await openingOf(bet.id)).toMatchObject({ attempts: 1, openingOdd: null, noOpeningReason: "partida_nao_localizada" });
    // Antes de 6 h não consulta de novo.
    expect((await runBridgePostgameOnce({ now: new Date(NOW.getTime() + 3_600_000), query: fakeQuery })).checked).toBe(0);
    // Depois delas o motivo não permanente volta à fila e a Bridge resolve.
    const later = new Date(NOW.getTime() + 7 * 3_600_000);
    expect(await runBridgePostgameOnce({ now: later, query: fakeQuery })).toMatchObject({ openings: 1, closings: 1 });
    expect(await closingOf(bet.id)).toMatchObject({ clvReliable: true, noOddsReason: null });
  });

  it("no teto de tentativas a aposta sai da busca", async () => {
    const { bet } = await seedScenario();
    await db.prisma.betOpening.create({ data: { betId: bet.id, attempts: POSTGAME_MAX_ATTEMPTS,
      lastAttemptAt: new Date(NOW.getTime() - 7 * 3_600_000), noOpeningReason: "partida_nao_localizada" } });
    expect((await runBridgePostgameOnce({ now: NOW, query: fakeQuery })).checked).toBe(0);
  });

  it("erro nosso na consulta conta a tentativa e deixa o fechamento explicado", async () => {
    const { bet } = await seedScenario();
    const result = await runBridgePostgameOnce({ now: NOW, query: async () => { throw new Error("consulta quebrou"); } });
    expect(result).toMatchObject({ checked: 1, failures: 1, missing: 1 });
    expect(await openingOf(bet.id)).toMatchObject({ attempts: 1, noOpeningReason: "falha_na_consulta" });
    expect(await closingOf(bet.id)).toMatchObject({ closingOdd: null, noOddsReason: "kickoff_sem_captura" });
    const acao = await db.prisma.operationalAction.findFirstOrThrow({ where: { title: "Falhas na busca pós-jogo na BridgeOdds" } });
    expect(acao.description).toContain(`• ${bet.evento}: `);
    expect(acao.description).toContain("👉");
  });
});

describe("agenda e falhas da Bridge", () => {
  const at = (ms: number) => new Date(KICKOFF.getTime() + ms);
  const H = 3_600_000, D = 24 * H;

  it("as seis consultas se espalham pela janela de 25 dias", async () => {
    const { bet } = await seedScenario();
    const rodada = async (ms: number) => (await runBridgePostgameOnce({ now: at(ms), query: async () => [] })).checked;
    // Cada ponto da agenda consulta uma vez; entre um e outro, nada.
    expect([await rodada(36 * 60_000), await rodada(2 * H)]).toEqual([1, 0]);
    expect([await rodada(6 * H), await rodada(12 * H)]).toEqual([1, 0]);
    expect([await rodada(24 * H), await rodada(48 * H)]).toEqual([1, 0]);
    expect([await rodada(72 * H), await rodada(5 * D)]).toEqual([1, 0]);
    expect([await rodada(7 * D), await rodada(19 * D)]).toEqual([1, 0]);
    expect([await rodada(20 * D), await rodada(24 * D)]).toEqual([1, 0]);
    expect((await openingOf(bet.id)).attempts).toBe(POSTGAME_MAX_ATTEMPTS);
  });

  it("aposta que entra tarde na fila não gasta duas consultas seguidas", async () => {
    await seedScenario();
    const rodada = async (ms: number) => (await runBridgePostgameOnce({ now: at(ms), query: async () => [] })).checked;
    expect([await rodada(10 * D), await rodada(10 * D + 20 * 60_000), await rodada(10 * D + 5 * H)]).toEqual([1, 0, 1]);
  });

  it("cota esgotada no meio da busca não gasta tentativa nem congela motivo", async () => {
    const { bet } = await seedScenario();
    const semCota = async () => ({ matches: [], truncated: true, incomplete: true });
    for (let rodada = 0; rodada < 6; rodada++) {
      expect(await runBridgePostgameOnce({ now: at(3 * H + rodada * 20 * 60_000), query: semCota }))
        .toMatchObject({ checked: 0, stoppedBy: "BudgetExhaustedError", deferred: 1 });
    }
    expect(await db.prisma.betOpening.findUnique({ where: { betId: bet.id } })).toBeNull();
    expect(await db.prisma.betClosing.findUnique({ where: { betId: bet.id } })).toBeNull();
    // A Bridge volta: a aposta ainda está na primeira consulta e fecha.
    expect(await runBridgePostgameOnce({ now: at(5 * H), query: fakeQuery })).toMatchObject({ openings: 1, closings: 1 });
    expect(await closingOf(bet.id)).toMatchObject({ clvReliable: true, provider: "bridgeodds" });
  });

  it("erro HTTP de uma aposta pula só ela: a mais nova fecha na mesma rodada, e a antiga volta depois do intervalo", async () => {
    const antiga = await seedScenario({ ext: "antiga", kickoffDate: new Date(KICKOFF.getTime() - 5 * D) });
    const nova = await seedScenario({ ext: "nova" });
    // A consulta da data antiga é recusada sempre, como um 400 fixo da Bridge.
    const corte = new Date(KICKOFF.getTime() - 2 * D).toISOString().slice(0, 10);
    const recusaAntiga = async (params: { date: string }) => {
      if (params.date < corte) throw new ProviderRequestError("BridgeOdds query falhou", { status: 400, error: "HTTP 400" });
      return [birmingham];
    };
    expect(await runBridgePostgameOnce({ now: NOW, query: recusaAntiga }))
      .toMatchObject({ checked: 2, skipped: 1, closings: 1, missing: 0, failures: 0, stoppedBy: null });
    expect(await closingOf(nova.bet.id)).toMatchObject({ clvReliable: true, provider: "bridgeodds" });
    expect(await openingOf(antiga.bet.id)).toMatchObject({ attempts: 0, lastAttemptAt: NOW, noOpeningReason: null });
    expect(await db.prisma.betClosing.findUnique({ where: { betId: antiga.bet.id } })).toBeNull();
    // Antes do intervalo ela não volta; depois dele, volta e fecha.
    expect((await runBridgePostgameOnce({ now: at(4 * H), query: fakeQuery })).checked).toBe(0);
    expect(await runBridgePostgameOnce({ now: at(8 * H + 60_000), query: fakeQuery })).toMatchObject({ checked: 1, closings: 1 });
    expect(await closingOf(antiga.bet.id)).toMatchObject({ clvReliable: true });
  });

  it("seis voltas paradas no teto esgotam a busca com partida_nao_localizada, e a aposta sai do lote", async () => {
    const { bet } = await seedScenario();
    const noTeto = async () => ({ matches: [], truncated: true });
    for (const ms of [36 * 60_000, 6 * H, 24 * H, 72 * H, 7 * D]) {
      expect(await runBridgePostgameOnce({ now: at(ms), query: noTeto })).toMatchObject({ checked: 1, missing: 1 });
    }
    // Até a quinta, nenhum motivo congelado.
    expect(await db.prisma.betClosing.findUnique({ where: { betId: bet.id } })).toBeNull();
    expect(await runBridgePostgameOnce({ now: at(20 * D), query: noTeto })).toMatchObject({ checked: 1, missing: 1 });
    expect(await closingOf(bet.id)).toMatchObject({ closingOdd: null, clvReliable: false, noOddsReason: "partida_nao_localizada" });
    expect(await openingOf(bet.id)).toMatchObject({ attempts: POSTGAME_MAX_ATTEMPTS, noOpeningReason: "partida_nao_localizada" });
    expect((await runBridgePostgameOnce({ now: at(24 * D), query: noTeto })).checked).toBe(0);
  });

  it.each([401, 403, 429])("Bridge indisponível para qualquer consulta (HTTP %i) para o lote sem gastar tentativa", async (status) => {
    const { bet } = await seedScenario();
    const fora = async () => { throw new ProviderRequestError("BridgeOdds query falhou", { status, error: `HTTP ${status}` }); };
    expect(await runBridgePostgameOnce({ now: NOW, query: fora }))
      .toMatchObject({ checked: 0, failures: 0, skipped: 0, stoppedBy: "ProviderRequestError", deferred: 1 });
    expect(await db.prisma.betOpening.findUnique({ where: { betId: bet.id } })).toBeNull();
    expect(await db.prisma.betClosing.findUnique({ where: { betId: bet.id } })).toBeNull();
  });

  it.each(["id", "nome"])("resposta parada no teto de páginas conta a vez sem congelar motivo, na busca por %s", async (caminho) => {
    const { bet } = await seedScenario({ ext: "teto", kickoffDate: new Date(KICKOFF.getTime() - 5 * D) });
    const outra = await seedScenario({ ext: "outra" });
    if (caminho === "nome") {
      await db.prisma.betSharp.update({ where: { betId: bet.id }, data: { provider: null, providerMatchId: null } });
      clearBridgeCatalogCache();
    }
    // As datas da primeira aposta param no teto de páginas; as da outra respondem.
    const corte = new Date(KICKOFF.getTime() - 2 * D).toISOString().slice(0, 10);
    const noTeto = async (params: { date: string }) => (params.date < corte ? { matches: [], truncated: true } : [birmingham]);
    expect(await runBridgePostgameOnce({ now: NOW, query: noTeto }))
      .toMatchObject({ checked: 2, missing: 1, skipped: 0, closings: 1, stoppedBy: null });
    expect(await openingOf(bet.id)).toMatchObject({ attempts: 1, lastAttemptAt: NOW, noOpeningReason: null });
    expect(await db.prisma.betClosing.findUnique({ where: { betId: bet.id } })).toBeNull();
    expect(await closingOf(outra.bet.id)).toMatchObject({ clvReliable: true });
  });

  it("aposta corrigida depois das seis tentativas volta a ser buscada", async () => {
    const { bet } = await seedScenario();
    await db.prisma.betOpening.create({ data: { betId: bet.id, attempts: POSTGAME_MAX_ATTEMPTS,
      lastAttemptAt: new Date(NOW.getTime() - 7 * H), noOpeningReason: "partida_nao_localizada" } });
    expect((await runBridgePostgameOnce({ now: NOW, query: fakeQuery })).checked).toBe(0);
    // O dono corrige o horário: a edição estrutural leva a abertura e o contador do jogo antigo.
    const kickoff = new Date(KICKOFF.getTime() - 10 * 60_000);
    await applyBetEdit({ betId: bet.id, actor: "test", fields: { data: kickoff, evento: bet.evento, esporte: bet.esporte,
      competicao: bet.competicao, pais: bet.pais, mercado: bet.mercado, selecao: bet.selecao, odds: 1.5, stake: 1 } });
    expect(await db.prisma.betOpening.findUnique({ where: { betId: bet.id } })).toBeNull();
    // O enrich confirma a identidade de novo, e a busca volta.
    await db.prisma.betSharp.create({ data: { betId: bet.id, identityStatus: "MATCHED", provider: "bridgeodds",
      providerMatchId: String(birmingham.match_id), confidence: 90 } });
    expect(await runBridgePostgameOnce({ now: NOW, query: fakeQuery })).toMatchObject({ checked: 1, openings: 1, closings: 1 });
  });
});

describe("prazo da rodada", () => {
  it("job cancelado pelo pg-boss não pega aposta nova", async () => {
    await seedScenario();
    let consultas = 0;
    const result = await runBridgePostgameOnce({ query: async () => { consultas += 1; return [birmingham]; }, now: NOW,
      signal: AbortSignal.abort() });
    expect(result).toMatchObject({ checked: 0, deferred: 1 });
    expect(consultas).toBe(0);
  });

  it("aos 15 min para de pegar aposta nova; a que ficou vai para a rodada seguinte", async () => {
    await seedScenario({ ext: "a" });
    await seedScenario({ ext: "b" });
    let chamadas = 0;
    // O relógio anda 16 min depois da primeira aposta.
    const clock = () => (chamadas++ < 2 ? 0 : 16 * 60_000);
    const result = await runBridgePostgameOnce({ query: fakeQuery, now: NOW, clock });
    expect(result).toMatchObject({ checked: 1, closings: 1, deferred: 1 });
    expect(await db.prisma.betClosing.count({ where: { clvReliable: true } })).toBe(1);
  });

  it("nunca duas rodadas ao mesmo tempo", async () => {
    await seedScenario();
    let liberar: () => void = () => undefined;
    const consultaPresa = new Promise<void>((resolve) => { liberar = resolve; });
    const primeira = runBridgePostgameOnce({ query: async () => { await consultaPresa; return [birmingham]; }, now: NOW });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(runBridgePostgameOnce({ query: fakeQuery, now: NOW })).resolves.toMatchObject({ overlapped: true, checked: 0 });
    liberar();
    await expect(primeira).resolves.toMatchObject({ checked: 1, closings: 1 });
  });
});
