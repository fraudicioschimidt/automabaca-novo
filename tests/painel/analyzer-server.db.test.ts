import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { readAnalyzer } from "@/src/services/painel/queries/analyzer";
import { emCursoDaLinha } from "@/app/_design/lib/balde-em-curso";
import { getBankrollSummaries } from "@/src/services/painel/queries/bankrolls";
import { testedAnData } from "@/app/_design/lib/tested-analyzer";
import { snapshotClosingForBet } from "@/src/services/sharp/closing/pinnacle17-snapshot";
import { computeOverviewV1 } from "@/src/domain/analyzer/overview";
import { parseAnalyzerQuery } from "@/src/domain/analyzer-query";

let db: TestDb;
beforeAll(() => { db = createTestDb(); });
beforeEach(async () => { await db.reset(); });
afterAll(async () => { await db.dispose(); });
const today = "2026-09-09";

describe("Analyzer consulta o recorte antes do limite", () => {
  it("preço provisório preservado pela guarda ao vivo não vira fechamento coberto", async () => {
    const bank = await db.prisma.bankroll.create({ data: { nome: "Execução", slug: "execucao" } });
    const kickoff = new Date("2026-09-09T12:00:00Z");
    const bet = await db.prisma.bet.create({ data: {
      bankrollId: bank.id, evento: "A vs B", esporte: "Soccer", mercado: "Moneyline", selecao: "A",
      odds: 1.95, stake: 1, data: kickoff, sportResolutionStatus: "CONFIRMED", sportResolvedAt: kickoff,
      registradoEm: new Date("2026-09-09T11:00:00Z"), sourcePostedAt: new Date("2026-09-09T11:00:00Z"),
      liveScoreHome: 0, liveScoreAway: 0,
      closing: { create: { closingRawOdd: 1.9, closingOdd: 2, clvReliable: false, fetchedAt: null } },
    }, include: { sharp: true, closing: true } });
    expect(await snapshotClosingForBet(bet, kickoff)).toEqual({ closed: true });
    const { rows } = await readAnalyzer(bank.id, parseAnalyzerQuery(), today);
    expect(rows[0]).toMatchObject({ closingRawOdd: 1.9, closingNoOddsReason: "aposta_ao_vivo" });
    const execution = testedAnData.S(rows);
    expect(execution.withClose).toHaveLength(0);
    expect(execution.fechamentoCobertura.naoSeAplica).toHaveLength(1);
    expect(execution.meanEF).toBeNull();
  });

  it("inclui comparação e a pendente de jogo futuro; exclui outra casa, modalidade e removidas", async () => {
    const bank = await db.prisma.bankroll.create({ data: { nome: "Analyzer", slug: "analyzer" } });
    const fixture = { bankrollId: bank.id, evento: "A vs B", esporte: "Soccer", mercado: "Moneyline", selecao: "A", odds: 2, stake: 1, sportResolvedAt: new Date(), casaDeAposta: "Casa A" };
    for (const [day, extra] of [
      ["09", {}], ["02", {}], ["01", {}], ["10", {}],
      ["09", { esporte: "Basketball" }], ["09", { casaDeAposta: "Casa B" }], ["09", { deletedAt: new Date() }],
    ] as const) await db.prisma.bet.create({ data: { ...fixture, data: new Date(`2026-09-${day}T12:00:00Z`), ...extra } });
    const result = await readAnalyzer(bank.id, parseAnalyzerQuery({ periodo: "7d", esporte: "Soccer", casa: "Casa A" }), today);
    expect(result.largeHistory).toBeNull();
    expect(result.rows.map((row) => row.data.toISOString().slice(8, 10))).toEqual(["01", "02", "09", "10"]);
    expect((await readAnalyzer("missing", parseAnalyzerQuery(), today)).rows).toEqual([]);
  });

  it("filtra pelo nome do esporte que o painel mostra e pela casa como texto, sem diferenciar maiúsculas", async () => {
    const bank = await db.prisma.bankroll.create({ data: { nome: "Filtros", slug: "filtros" } });
    const fixture = { bankrollId: bank.id, data: new Date("2026-09-09T12:00:00Z"), evento: "A vs B", mercado: "Moneyline", selecao: "A", odds: 2, stake: 1, sportResolvedAt: new Date() };
    await db.prisma.bet.create({ data: { ...fixture, id: "futebol-a", esporte: "Soccer", casaDeAposta: "Casa A" } });
    await db.prisma.bet.create({ data: { ...fixture, id: "basquete-a", esporte: "Basketball", casaDeAposta: "Casa A" } });
    await db.prisma.bet.create({ data: { ...fixture, id: "futebol-b", esporte: "Soccer", casaDeAposta: "Casa B" } });
    await db.prisma.bet.create({ data: { ...fixture, id: "tenis-percent", esporte: "Tennis", casaDeAposta: "50% Bet" } });
    await db.prisma.bet.create({ data: { ...fixture, id: "a-confirmar", esporte: "Unknown", sportResolutionStatus: "PENDING", sportResolvedAt: null, casaDeAposta: "Casa C" } });
    const ids = async (filtro: Record<string, string>) =>
      (await readAnalyzer(bank.id, parseAnalyzerQuery(filtro), today)).rows.map((row) => row.id).sort();
    expect(await ids({ esporte: "Futebol", casa: "casa a" })).toEqual(["futebol-a"]);
    expect(await ids({ esporte: "soccer" })).toEqual(["futebol-a", "futebol-b"]);
    // O painel mostra "Unknown" como "A confirmar"; os dois nomes filtram o mesmo recorte.
    expect(await ids({ esporte: "a confirmar" })).toEqual(["a-confirmar"]);
    expect(await ids({ esporte: "unknown" })).toEqual(["a-confirmar"]);
    expect(await ids({ casa: "CASA A" })).toEqual(["basquete-a", "futebol-a"]);
    // A casa é comparada como texto: curinga do LIKE não casa outra casa nem derruba a consulta.
    for (const casa of ["%", "casa\\", "Cas_ A"]) expect(await ids({ casa })).toEqual([]);
    expect(await ids({ casa: "50% bet" })).toEqual(["tenis-percent"]);
  });

  it("resume 25.001 apostas inteiras, pagina sem repetição e permite período menor", async () => {
    const bank = await db.prisma.bankroll.create({ data: { nome: "Grande", slug: "grande" } });
    // Uma instrução parametrizada evita 25 mil round trips. Somente banco descartável.
    await db.prisma.$executeRaw`
      INSERT INTO bets (id, "bankrollId", data, evento, esporte, mercado, selecao, odds, stake,
        "sportResolvedAt", "updatedAt", status, lucro, "settledAt")
      SELECT 'large-' || n, ${bank.id}, '2026-01-01T12:00:00Z'::timestamptz, 'A vs B',
        'Soccer', 'Moneyline', 'A', 2, 1, now(), now(), 'WON'::"BetStatus", 1, now()
      FROM generate_series(1, 25001) n`;
    const first = await readAnalyzer(bank.id, parseAnalyzerQuery(), today);
    expect(first.rows).toEqual([]);
    expect(first.largeHistory).toMatchObject({ total: 25001, resolved: 25001, pending: 0, stake: 25001, profit: 25001, roi: 100, page: 1, pages: 501 });
    expect(first.largeHistory?.rows).toHaveLength(50);
    const second = await readAnalyzer(bank.id, parseAnalyzerQuery({ pagina: "2" }), today);
    expect(second.largeHistory?.profit).toBe(first.largeHistory?.profit);
    expect(new Set([...first.largeHistory!.rows, ...second.largeHistory!.rows].map((row) => row.id)).size).toBe(100);
    const last = await readAnalyzer(bank.id, parseAnalyzerQuery({ pagina: "9999" }), today);
    expect(last.largeHistory).toMatchObject({ page: 501 });
    expect(last.largeHistory?.rows).toHaveLength(1);
    expect(await readAnalyzer(bank.id, parseAnalyzerQuery({ periodo: "7d" }), today)).toEqual({ rows: [], largeHistory: null });
    await db.prisma.bet.update({ where: { id: "large-1" }, data: { status: "PENDING", lucro: 0, settledAt: null } });
    await db.prisma.bet.update({ where: { id: "large-2" }, data: { status: "VOID", lucro: 0 } });
    const mixed = await readAnalyzer(bank.id, parseAnalyzerQuery(), today);
    expect(mixed.largeHistory).toMatchObject({ total: 25001, resolved: 24999, pending: 1, profit: 24999, stake: 24999, roi: 100 });
  });

  it("o recorte é pelo dia do jogo: a data da liquidação não põe nem tira aposta da janela", async () => {
    const bank = await db.prisma.bankroll.create({ data: { nome: "Eixo", slug: "eixo" } });
    const fixture = { bankrollId: bank.id, evento: "A vs B", esporte: "Soccer", mercado: "Moneyline", selecao: "A", odds: 2, stake: 1, sportResolvedAt: new Date() };
    const at = (day: string) => new Date(`2026-${day}T12:00:00Z`);
    const won = (id: string, game: string, settled: string) =>
      db.prisma.bet.create({ data: { ...fixture, id, data: at(game), status: "WON", lucro: 1, settledAt: at(settled) } });
    // Janela de 7 dias: 03 a 09/09; a anterior, 27/08 a 02/09.
    await won("jogo-na-janela-liquidada-depois", "09-08", "09-20");
    await won("jogo-na-anterior-liquidada-na-janela", "09-02", "09-09");
    await won("jogo-antes-liquidada-na-janela", "08-20", "09-09");
    await won("jogo-futuro-ja-liquidada", "09-15", "09-09");
    await db.prisma.bet.create({ data: { ...fixture, id: "pendente-jogo-futuro", data: at("09-15") } });
    await db.prisma.bet.create({ data: { ...fixture, id: "pendente-jogo-antigo", data: at("08-20") } });
    const { rows } = await readAnalyzer(bank.id, parseAnalyzerQuery({ periodo: "7d" }), today);
    expect(rows.map((row) => row.id)).toEqual([
      "jogo-na-anterior-liquidada-na-janela", "jogo-na-janela-liquidada-depois", "pendente-jogo-futuro",
    ]);
  });

  it("o resumo do histórico extenso usa o mesmo recorte: dia do jogo e pendente de jogo futuro", async () => {
    const bank = await db.prisma.bankroll.create({ data: { nome: "Resumo", slug: "resumo" } });
    // 25.001 jogos em 08/09 (dentro dos 7 dias), todos liquidados em 20/09, fora da janela.
    await db.prisma.$executeRaw`
      INSERT INTO bets (id, "bankrollId", data, evento, esporte, mercado, selecao, odds, stake,
        "sportResolvedAt", "updatedAt", status, lucro, "settledAt")
      SELECT 'eixo-' || n, ${bank.id}, '2026-09-08T12:00:00Z'::timestamptz, 'A vs B',
        'Soccer', 'Moneyline', 'A', 2, 1, now(), now(), 'WON'::"BetStatus", 1, '2026-09-20T12:00:00Z'::timestamptz
      FROM generate_series(1, 25001) n`;
    const fixture = { bankrollId: bank.id, evento: "A vs B", esporte: "Soccer", mercado: "Moneyline", selecao: "A", odds: 2, stake: 1, sportResolvedAt: new Date() };
    // Jogo na janela anterior, liquidado hoje: fora do resumo, que não tem comparativo.
    await db.prisma.bet.create({ data: { ...fixture, id: "anterior-liquidada-hoje", data: new Date("2026-09-02T12:00:00Z"), status: "WON", lucro: 7, settledAt: new Date("2026-09-09T12:00:00Z") } });
    await db.prisma.bet.create({ data: { ...fixture, id: "futura-ja-liquidada", data: new Date("2026-09-15T12:00:00Z"), status: "WON", lucro: 7, settledAt: new Date("2026-09-09T12:00:00Z") } });
    await db.prisma.bet.create({ data: { ...fixture, id: "pendente-futura", data: new Date("2026-09-15T12:00:00Z") } });
    const { rows, largeHistory } = await readAnalyzer(bank.id, parseAnalyzerQuery({ periodo: "7d" }), today);
    expect(rows).toEqual([]);
    expect(largeHistory).toMatchObject({ total: 25002, resolved: 25001, pending: 1, profit: 25001, stake: 25001 });
    expect(largeHistory?.rows[0]?.id).toBe("pendente-futura");
  });

  it("leva settledAt até as agregações e desempata kickoffs iguais por id", async () => {
    const bank = await db.prisma.bankroll.create({ data: { nome: "Ordem", slug: "ordem" } });
    const data = new Date("2026-06-20T12:00:00Z");
    const settledAt = new Date("2026-06-20T20:00:00Z");
    const fixture = { bankrollId: bank.id, data, esporte: "Soccer", mercado: "Total", selecao: "Under 2.5", odds: 1.9, stake: 1, sportResolvedAt: new Date() };
    await db.prisma.bet.create({ data: { ...fixture, id: "ffffffff-ffff-4fff-8fff-ffffffffffff", evento: "Time Z vs Time Y" } });
    await db.prisma.bet.create({
      data: { ...fixture, id: "00000000-0000-4000-8000-000000000001", evento: "Time A vs Time B", status: "WON", lucro: 0.9, settledAt },
    });
    const { rows } = await readAnalyzer(bank.id, parseAnalyzerQuery(), today);
    expect(rows.map((row) => row.evento)).toEqual(["Time A vs Time B", "Time Z vs Time Y"]);
    expect(rows[0]?.settledAt).toEqual(settledAt);
  });
});

describe("Analyzer da carteira: todas as bancas, em reais", () => {
  it("junta as bancas pelo valor da unidade gravado em cada aposta e respeita o recorte", async () => {
    const alfa = await db.prisma.bankroll.create({ data: { nome: "Alfa", slug: "alfa", valorUnidade: 50 } });
    const beta = await db.prisma.bankroll.create({ data: { nome: "Beta", slug: "beta", valorUnidade: 20 } });
    const homonima = await db.prisma.bankroll.create({ data: { nome: "Alfa", slug: "alfa-2" } });
    const fixture = { evento: "A vs B", esporte: "Soccer", mercado: "Moneyline", selecao: "A", odds: 1.9, sportResolvedAt: new Date() };
    const settledAt = new Date("2026-09-09T15:00:00Z");
    const dia = (d: string) => new Date(`2026-09-${d}T12:00:00Z`);
    // O valor da unidade que vale é o da aposta (snapshot), não o atual da banca.
    await db.prisma.bet.create({ data: { ...fixture, id: "alfa-ganha", bankrollId: alfa.id, data: dia("09"), stake: 1, status: "WON", lucro: 0.9, settledAt, valorUnidade: 40 } });
    await db.prisma.bet.create({ data: { ...fixture, id: "beta-perde", bankrollId: beta.id, data: dia("08"), stake: 2, status: "LOST", lucro: -2, settledAt, valorUnidade: 20 } });
    await db.prisma.bet.create({ data: { ...fixture, id: "homonima", bankrollId: homonima.id, data: dia("07"), stake: 1, valorUnidade: 10 } });
    await db.prisma.bet.create({ data: { ...fixture, id: "anterior", bankrollId: beta.id, data: dia("01"), stake: 1, valorUnidade: 20 } });
    await db.prisma.bet.create({ data: { ...fixture, id: "fora", bankrollId: beta.id, data: dia("01"), stake: 1, valorUnidade: 20, esporte: "Basketball" } });
    await db.prisma.bet.create({ data: { ...fixture, id: "removida", bankrollId: alfa.id, data: dia("09"), stake: 1, valorUnidade: 50, deletedAt: new Date() } });

    const { rows, largeHistory } = await readAnalyzer(null, parseAnalyzerQuery({ periodo: "7d", esporte: "Futebol" }), today);
    expect(largeHistory).toBeNull();
    expect(rows.find((row) => row.id === "alfa-ganha")).toMatchObject({ stakeUnits: 1, profitUnits: 0.9 });
    expect(rows.map((row) => [row.id, row.bankrollName, row.stake, row.lucro, row.valorUnidade])).toEqual([
      ["anterior", "Beta", 20, 0, 20],
      ["homonima", "Alfa (alfa-2)", 10, 0, 10],
      ["beta-perde", "Beta", 40, -40, 20],
      ["alfa-ganha", "Alfa (alfa)", 40, 36, 40],
    ]);
    // A banca continua em unidades, sem o nome da banca em cada linha.
    const daBanca = await readAnalyzer(beta.id, parseAnalyzerQuery({ periodo: "7d" }), today);
    expect(daBanca.rows.map((row) => [row.id, row.stake, row.lucro, row.bankrollName, row.valorUnidade])).toEqual([
      ["anterior", 1, 0, undefined, undefined], ["fora", 1, 0, undefined, undefined], ["beta-perde", 2, -2, undefined, undefined],
    ]);
  });

  it("passar do limite de detalhe conserva os totais em reais com arredondamento por aposta", async () => {
    const bank = await db.prisma.bankroll.create({ data: { nome: "Precisão", slug: "precisao" } });
    await db.prisma.$executeRaw`
      INSERT INTO bets (id, "bankrollId", data, evento, esporte, mercado, selecao, odds, stake,
        "valorUnidade", "sportResolvedAt", "updatedAt", status, lucro, "settledAt", "casaDeAposta")
      SELECT 'precisao-' || n, ${bank.id}, '2026-09-09T12:00:00Z'::timestamptz,
        'A vs B', 'Soccer', 'Moneyline', 'A', 2, 0.123457,
        CASE WHEN n % 2 = 1 THEN 33.33 ELSE 7.07 END, now(), now(),
        CASE WHEN n % 2 = 1 THEN 'LOST'::"BetStatus" ELSE 'WON'::"BetStatus" END,
        CASE WHEN n % 2 = 1 THEN -0.123457 ELSE 0.123457 END, now(), '50% Bet'
      FROM generate_series(1, 25000) n`;
    const query = parseAnalyzerQuery({ periodo: "hoje", esporte: "Futebol", casa: "50% bet" });
    const detail = await readAnalyzer(null, query, today);
    expect(detail.largeHistory).toBeNull();
    const overview = computeOverviewV1(detail.rows);
    // 12.500 × (4,114822 + 0,872841); perdas usam o mesmo arredondamento simétrico.
    expect(overview.totalStake).toBe(62345.7875);
    expect(overview.totalLucro).toBe(-40524.7625);
    await db.prisma.bet.create({ data: {
      bankrollId: bank.id, data: new Date("2026-09-09T12:00:00Z"), evento: "C vs D", esporte: "Soccer",
      mercado: "Moneyline", selecao: "C", odds: 2, stake: 1, casaDeAposta: "50% Bet", sportResolvedAt: new Date(),
    } });
    await db.prisma.bet.createMany({ data: [
      { id: "outro-esporte", esporte: "Basketball" },
      { id: "outra-casa", casaDeAposta: "50X Bet" },
      { id: "removida", deletedAt: new Date() },
      { id: "outro-dia", data: new Date("2026-09-08T12:00:00Z") },
    ].map((extra) => ({
      bankrollId: bank.id, data: new Date("2026-09-09T12:00:00Z"), evento: "E vs F", esporte: "Soccer",
      mercado: "Moneyline", selecao: "E", odds: 2, stake: 100, lucro: 100, status: "WON" as const,
      casaDeAposta: "50% Bet", sportResolvedAt: new Date(), settledAt: new Date(), ...extra,
    })) });
    const { largeHistory } = await readAnalyzer(null, query, today);
    expect(largeHistory).toMatchObject({ total: 25001, resolved: 25000, pending: 1,
      stake: overview.totalStake, profit: overview.totalLucro, roi: overview.roi });
  });

  it("no histórico extenso, o resumo soma cada valor de unidade em reais e a página traz a banca", async () => {
    const alfa = await db.prisma.bankroll.create({ data: { nome: "Alfa", slug: "alfa" } });
    const beta = await db.prisma.bankroll.create({ data: { nome: "Beta", slug: "beta" } });
    await db.prisma.$executeRaw`
      INSERT INTO bets (id, "bankrollId", data, evento, esporte, mercado, selecao, odds, stake,
        "valorUnidade", "sportResolvedAt", "updatedAt", status, lucro, "settledAt")
      SELECT 'carteira-' || n, CASE WHEN n % 2 = 1 THEN ${alfa.id} ELSE ${beta.id} END,
        '2026-01-01T12:00:00Z'::timestamptz, 'A vs B', 'Soccer', 'Moneyline', 'A', 2, 1,
        CASE WHEN n % 2 = 1 THEN 50 ELSE 20 END, now(), now(), 'WON'::"BetStatus", 0.5, now()
      FROM generate_series(1, 25001) n`;
    const { largeHistory } = await readAnalyzer(null, parseAnalyzerQuery(), today);
    // 12.501 apostas a R$ 50 e 12.500 a R$ 20 por unidade.
    expect(largeHistory).toMatchObject({ total: 25001, resolved: 25001, pending: 0, stake: 875_050, profit: 437_525, roi: 50, pages: 501 });
    expect(new Set(largeHistory?.rows.map((row) => row.bankrollName))).toEqual(new Set(["Alfa", "Beta"]));
    expect(largeHistory?.rows.find((row) => row.bankrollName === "Alfa")).toMatchObject({ stake: 50, lucro: 25 });
  });
});

it("separa tipsters quando um nome literal coincide com o rótulo de um homônimo", async () => {
  const { channelMarketGrid } = await import("@/src/domain/analyzer/portfolio");
  for (const [slug, nome] of [["alfa", "Alfa"], ["alfa-2", "Alfa"], ["literal", "Alfa (alfa)"], ["literal-2", "Alfa (alfa) [literal]"]]) {
    const bank = await db.prisma.bankroll.create({ data: { nome: nome!, slug: slug! } });
    await db.prisma.bet.create({ data: { bankrollId: bank.id, data: new Date("2026-09-09T12:00:00Z"), evento: "A vs B", esporte: "Soccer", mercado: "Moneyline", selecao: "A", stake: 1, odds: 2, sportResolvedAt: new Date() } });
  }
  const { rows } = await readAnalyzer(null, parseAnalyzerQuery(), today);
  expect(new Set(rows.map(r => r.bankrollName)).size).toBe(4);
  const grid = channelMarketGrid(rows, r => r.bankrollName!);
  expect(grid.rows).toHaveLength(4);
  expect(grid.rows.map(r => r.total.bets)).toEqual([1, 1, 1, 1]);
});


describe("seleção da base histórica", () => {
  it("mantém perdas do canal pausado e sem CLV, inclusive no mercado homônimo do agrupamento", async () => {
    const paused = await db.prisma.bankroll.create({ data: {
      nome: "Pausado", slug: "pausado", sharpMode: "OFF", capturePausedAt: new Date(),
    } });
    const active = await db.prisma.bankroll.create({ data: { nome: "Ativo", slug: "ativo" } });
    const date = new Date("2026-09-05T12:00:00Z");
    const fixture = { data: date, registradoEm: new Date("2026-09-05T10:00:00Z"), sportResolvedAt: date,
      sportResolutionStatus: "CONFIRMED" as const, settledAt: date, evento: "A vs B", esporte: "Soccer",
      selecao: "A", odds: 2, stake: 1, mercado: "Outros mercados", status: "LOST" as const, lucro: -1, valorUnidade: 20 };
    await db.prisma.bet.create({ data: { ...fixture, id: "perda-mantida", bankrollId: paused.id } });
    await db.prisma.bet.create({ data: { ...fixture, id: "perda-removida", bankrollId: paused.id, deletedAt: date } });
    await db.prisma.bet.create({ data: { ...fixture, id: "ganho-mantido", bankrollId: active.id,
      mercado: "Moneyline", status: "WON", lucro: 1, valorUnidade: 5,
      closing: { create: { clv: 4, clvReliable: true, fetchedAt: date } },
    } });
    const { rows } = await readAnalyzer(null, parseAnalyzerQuery({ periodo: "tudo" }), today);
    expect(rows.map((row) => row.id).sort()).toEqual(["ganho-mantido", "perda-mantida"]);
    const carteira = testedAnData.C(rows);
    expect(carteira.portfolio).toMatchObject({ n: 2, settledN: 2, lucro: -15, clvN: 1 });
    const pausedRow = carteira.rows.find((row) => row.channel === "Pausado")!;
    expect(pausedRow.total).toMatchObject({ n: 1, settledN: 1, lucro: -20, clvN: 0 });
    expect(pausedRow.cells.flatMap((cell) => cell?.membros ?? []).map((row) => row.id)).toEqual(["perda-mantida"]);
  });
});


it("reembolsos encerrados preservam ROI e acerto sem pendência artificial", async () => {
  const bank = await db.prisma.bankroll.create({ data: { nome: "Resultados", slug: "resultados" } });
  const base = { bankrollId: bank.id, evento: "A vs B", esporte: "Soccer", mercado: "Moneyline", selecao: "A",
    odds: 2, data: new Date("2026-09-09T12:00:00Z"), valorUnidade: 25,
    sportResolutionStatus: "CONFIRMED" as const, sportResolvedAt: new Date("2026-09-09T10:00:00Z") };
  await db.prisma.bet.createMany({ data: [
    { ...base, id: "won", status: "WON", stake: 1, lucro: 1, settledAt: new Date("2026-09-09T15:00:00Z") },
    { ...base, id: "void", status: "VOID", stake: 20, lucro: 0, settledAt: new Date("2026-09-09T15:00:00Z") },
    { ...base, id: "canceled", status: "CANCELED", stake: 30, lucro: 0, settledAt: new Date("2026-09-09T15:00:00Z") },
    { ...base, id: "pending", status: "PENDING", stake: 50, lucro: 0 },
  ] });
  for (const pending of [1, 0]) {
    const { rows } = await readAnalyzer(bank.id, parseAnalyzerQuery(), today);
    const overview = computeOverviewV1(rows);
    expect(overview).toMatchObject({ totalBets: 4, resolvedBets: 1, pendingBets: pending, totalLucro: 1, totalStake: 1, roi: 100, sucessoPct: 100 });
    const periods = testedAnData.P(rows);
    expect(emCursoDaLinha(periods.monthly[0]!)).toEqual({ total: 4, pendentes: pending });
    const [summary] = await getBankrollSummaries();
    expect(summary).toMatchObject({ apostas: 4, pendentes: pending, stakeFinalizada: 1, lucro: 1, roi: 100, acerto: 100, profitBrl: 25, stakedBrl: 25 });
    if (pending) await db.prisma.bet.update({ where: { id: "pending" }, data: { status: "VOID", settledAt: new Date("2026-09-09T15:00:00Z") } });
  }
});
