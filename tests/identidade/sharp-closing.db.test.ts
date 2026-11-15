import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { eligibleBetSelect, runClosingSyncOnce } from "@/src/services/sharp/closing/sync";
import { processBridgeClv } from "@/src/services/sharp/closing/bridge-clv";
import type { BridgeQueryPage } from "@/src/providers/bridgeodds/types";
import { toNumber } from "@/src/domain/money";
import { writeClosingOnce } from "@/src/services/sharp/closing-guard";
import { recomputePriceSnapshot } from "@/src/domain/price-provenance";
import { editarBankroll } from "@/src/services/bankrolls/manage";
import { foraDaBaseDeCobertura } from "@/src/domain/no-odds-reason";
import { applyBetEdit } from "@/src/services/bets/edit";

/**
 * Closing/CLV contra Postgres real. O fixture contém placar final de propósito:
 * o teste prova que a informação não atravessa a fronteira de resultado.
 */
const page = JSON.parse(
  readFileSync(new URL("../fixtures/bridgeodds/opening-closing-page.json", import.meta.url), "utf8"),
) as BridgeQueryPage;
const birmingham = page.results.find(
  (m) => m.home === "Birmingham Legion" && m.home_score === 3,
)!;

const fakeQuery = async () => [birmingham];
// Dez minutos depois do kickoff: a Bridge é do `closing.sync` só até 30 min.
const NOW = new Date("2026-06-10T20:10:00Z");

const findEvent = vi.hoisted(() => vi.fn(async (): Promise<{ startTime: string } | null> => null));
vi.mock("@/src/providers/pinnacle17/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/src/providers/pinnacle17/client")>(),
  findPinnacle17EventById: findEvent,
}));

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

async function seedSettledScenario(params?: {
  sharpMode?: "CLV_ONLY" | "IDENTITY_ONLY";
  selecao?: string;
  mercado?: string;
}) {
  const bankroll = await db.prisma.bankroll.create({
    data: {
      nome: "Big Data",
      slug: "big-data",
      valorUnidade: 100,
      sharpMode: params?.sharpMode ?? "CLV_ONLY",
    },
  });
  const conta = await db.prisma.conta.create({
    data: {
      casaDeAposta: "Betano",
      titular: "F",
      saldoInicial: 1000,
      saldoAtual: 1000,
      bankrollLinks: { create: { bankrollId: bankroll.id } },
    },
  });
  const bet = await db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      settledAt: null,
      bankrollId: bankroll.id,
      contaId: conta.id,
      data: new Date("2026-06-10T20:00:00Z"), // kickoff já passou vs NOW
      evento: "Birmingham Legion vs Corpus Christi",
      esporte: "Soccer",
      competicao: "USL Cup",
      pais: "USA",
      mercado: params?.mercado ?? "Moneyline",
      selecao: params?.selecao ?? "Birmingham Legion",
      odds: 1.5,
      stake: 1,
      status: "PENDING",
      source: "test",
      sourceExternalId: `cl-${params?.selecao ?? "ml"}`,
      sharp: {
        create: {
          identityStatus: "MATCHED",
          provider: "bridgeodds",
          providerMatchId: String(birmingham.match_id),
          confidence: 90,
        },
      },
    },
  });
  return { bankroll, conta, bet };
}

describe("runClosingSyncOnce (Postgres real + jogo terminado do fixture)", () => {
  it("congela closing+CLV sem ingerir placar nem alterar dinheiro", async () => {
    const { conta, bet } = await seedSettledScenario();
    const result = await runClosingSyncOnce({ query: fakeQuery, now: NOW });

    expect(result).toMatchObject({ processed: 1, closed: 1, failures: 0 });

    const closing = await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(closing.clvReliable).toBe(true);
    expect(closing.provider).toBe("bridgeodds"); // atribuição do provider do fechamento
    expect(toNumber(closing.closingOdd)).toBeGreaterThan(1);
    expect(toNumber(closing.closingRawOdd)).toBeCloseTo(1.33, 2); // ML home no fixture
    const recomputedClosing = recomputePriceSnapshot(closing.closingPriceSnapshot as never);
    expect(recomputedClosing?.raw).toBeCloseTo(1.33, 2);
    expect(recomputedClosing?.fair).toBeGreaterThan(1);
    expect(await db.prisma.betResult.count({ where: { betId: bet.id } })).toBe(0);
    expect(closing.source).toBe("CRON");
    // CLV = odds cravada vs fair de fechamento; o placar presente no mesmo
    // payload não participa do cálculo nem do efeito financeiro.
    expect(toNumber(closing.clv)).toBeGreaterThan(0);

    const pending = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(pending.status).toBe("PENDING");
    expect(toNumber(pending.lucro)).toBe(0);

    const contaDb = await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } });
    expect(toNumber(contaDb.saldoAtual)).toBe(1000);

    expect(
      await db.prisma.settlementEvent.count({ where: { betId: bet.id } }),
    ).toBe(0);
  });

  it("aposta trocada de jogo durante a consulta não recebe a liga, a abertura nem o fechamento do jogo antigo", async () => {
    const { bet } = await seedSettledScenario();
    // A captura deixou liga e país vazios: o fechamento os preencheria com os da Bridge.
    await db.prisma.bet.update({ where: { id: bet.id }, data: { competicao: "", pais: "" } });
    let editada = false;
    const result = await runClosingSyncOnce({
      now: NOW,
      query: async () => {
        if (!editada) {
          editada = true;
          const { manualSettlementVersion } = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
          await applyBetEdit({ betId: bet.id, actor: "dono", financialAuthority: "operator", expectedVersion: manualSettlementVersion, fields: {
            data: bet.data, evento: "Outro A vs Outro B", esporte: bet.esporte, competicao: "Liga Outra", pais: "Brazil",
            mercado: bet.mercado, selecao: "Outro A", odds: 1.5, stake: 1 } });
        }
        return [birmingham];
      },
    });
    expect(result.closed).toBe(0);
    expect(await db.prisma.betClosing.findUnique({ where: { betId: bet.id } })).toBeNull();
    expect(await db.prisma.betOpening.findUnique({ where: { betId: bet.id } })).toBeNull();
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .toMatchObject({ evento: "Outro A vs Outro B", competicao: "Liga Outra", pais: "Brazil" });
  });

  it("jogo remarcado na Bridge: a linha antes do início real não vira fechamento", async () => {
    const { bet } = await seedSettledScenario();
    // A Bridge dá o início 2 h depois do horário gravado: o `closing` ainda é a linha atual.
    const remarcado = { ...birmingham, match_date: "2026-06-10T22:00:00Z" };
    const result = await runClosingSyncOnce({ query: async () => [remarcado], now: new Date("2026-06-10T20:05:00Z") });
    expect(result).toMatchObject({ processed: 1, closed: 0, failures: 0 });
    const closing = await db.prisma.betClosing.findUnique({ where: { betId: bet.id } });
    expect(closing?.fetchedAt ?? null).toBeNull();
    expect(closing?.closingOdd ?? null).toBeNull();
  });

  it("jogo adiado na Pinnacle17: a linha da Bridge colhida antes do horário da aposta não vira fechamento", async () => {
    const { bet } = await seedSettledScenario();
    // A Bridge ficou com 20:00 (a primeira listagem); a aposta tem 22:00.
    await db.prisma.bet.update({ where: { id: bet.id }, data: { data: new Date("2026-06-10T22:00:00Z") } });
    const eligible = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id }, select: eligibleBetSelect });

    const cedo = new Date("2026-06-10T20:05:00Z");
    await expect(processBridgeClv(eligible, birmingham, cedo, { priceObservedAt: cedo })).resolves.toBe(false);
    expect((await db.prisma.betClosing.findUnique({ where: { betId: bet.id } }))?.fetchedAt ?? null).toBeNull();

    const depois = new Date("2026-06-10T22:05:00Z");
    await expect(processBridgeClv(eligible, birmingham, depois, { priceObservedAt: depois })).resolves.toBe(true);
  });

  it("jogo adiado com os dois horários velhos: a Pinnacle17 ainda o dá por começar e a linha não vira fechamento", async () => {
    const { bet } = await seedSettledScenario();
    const eligible = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id }, select: eligibleBetSelect });
    const now = new Date("2026-06-10T20:05:00Z");
    // A aposta e a Bridge têm 20:00; a Pinnacle17, pelo mesmo id, dá o jogo para o dia seguinte.
    findEvent.mockResolvedValueOnce({ startTime: "2026-06-11T23:00:00.000Z" });
    await expect(processBridgeClv(eligible, birmingham, now, { priceObservedAt: now })).resolves.toBe(false);
    expect((await db.prisma.betClosing.findUnique({ where: { betId: bet.id } }))?.fetchedAt ?? null).toBeNull();

    // Com o jogo começado no horário dela, fecha.
    findEvent.mockResolvedValueOnce({ startTime: "2026-06-10T20:00:00.000Z" });
    await expect(processBridgeClv(eligible, birmingham, now, { priceObservedAt: now })).resolves.toBe(true);
  });

  it("múltipla de jogos diferentes congela como `multipla`, sem consulta, e sai do lote", async () => {
    const { bet } = await seedSettledScenario();
    await db.prisma.bet.update({ where: { id: bet.id }, data: { legsJson: { kind: "parlay", legs: [
      { evento: "Birmingham Legion vs Corpus Christi", mercado: "Moneyline", selecao: "Birmingham Legion" },
      { evento: "Tampa Bay vs Miami", mercado: "Moneyline", selecao: "Tampa Bay" },
    ] } } });
    let consultas = 0;
    const result = await runClosingSyncOnce({ query: async () => { consultas += 1; return [birmingham]; }, now: NOW });
    expect(result).toMatchObject({ processed: 1, closed: 1 });
    expect(consultas).toBe(0);
    expect(await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } }))
      .toMatchObject({ closingOdd: null, clvReliable: false, noOddsReason: "multipla" });
    expect((await runClosingSyncOnce({ query: fakeQuery, now: NOW })).processed).toBe(0);
  });

  it("30 min depois do início a aposta da Bridge sai do closing.sync para a busca pós-jogo", async () => {
    const { bet } = await seedSettledScenario();
    let consultas = 0;
    const result = await runClosingSyncOnce({ query: async () => { consultas += 1; return [birmingham]; },
      now: new Date("2026-06-10T20:31:00Z") });
    expect(result.processed).toBe(0);
    expect(consultas).toBe(0);
    expect(await db.prisma.betClosing.findUnique({ where: { betId: bet.id } })).toBeNull();
  });

  it("segundo ciclo é vazio depois que o closing foi congelado", async () => {
    await seedSettledScenario();
    await runClosingSyncOnce({ query: fakeQuery, now: NOW });
    const second = await runClosingSyncOnce({ query: fakeQuery, now: NOW });
    expect(second.processed).toBe(0);
  });

  it("CLV_ONLY fecha sem liquidar (o closing é o coração do modo)", async () => {
    const { bet } = await seedSettledScenario({ sharpMode: "CLV_ONLY" });
    const result = await runClosingSyncOnce({ query: fakeQuery, now: NOW });
    expect(result).toMatchObject({ closed: 1 });
    const closing = await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(toNumber(closing.clv)).not.toBeNull();
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .resolves.toMatchObject({ status: "PENDING" });
  });

  it("IDENTITY_ONLY NÃO é elegível: sem CLV e sem auto-settle (props liquidam manual)", async () => {
    // Mesmo jogo terminado de um modo que fecha — só o modo muda. IDENTITY_ONLY
    // existe p/ canais de player props: identidade casa, mas não há linha p/ CLV
    // e o placar do jogo não resolve a prop → fora do ciclo de fechamento.
    const { bet } = await seedSettledScenario({ sharpMode: "IDENTITY_ONLY" });
    const result = await runClosingSyncOnce({ query: fakeQuery, now: NOW });
    expect(result.processed).toBe(0);
    expect(await db.prisma.betClosing.count({ where: { betId: bet.id } })).toBe(0);
    const still = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(still.status).toBe("PENDING"); // não auto-liquidou pelo placar
  });

  const outraAposta = (bankrollId: string, id: string, data: Date, kickoffInferido = false) => db.prisma.bet.create({ data: {
    id, sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(), bankrollId, data, kickoffInferido,
    evento: "Birmingham Legion vs Corpus Christi", esporte: "Soccer",
    mercado: "Moneyline", selecao: "Birmingham Legion", odds: 1.5, stake: 1, status: "PENDING",
  } });

  it.each([
    ["IDENTITY_ONLY", "identity_only"],
    ["OFF", "sharp_off"],
  ] as const)("banca que passa de %s a CLV_ONLY: o jogo que já passou fica com o motivo da política", async (modo, motivo) => {
    const { bankroll, bet } = await seedSettledScenario();
    await db.prisma.bankroll.update({
      where: { id: bankroll.id },
      data: { sharpMode: modo, sharpModeChangedAt: new Date("2026-06-01T00:00:00Z") },
    });
    // Casada pela Pinnacle17 enquanto a banca não media CLV: nenhuma cotação foi guardada.
    await db.prisma.betSharp.update({ where: { betId: bet.id }, data: { provider: "pinnacle17", providerMatchId: "888" } });
    const futura = await outraAposta(bankroll.id, "futura", new Date(Date.now() + 2 * 3_600_000));
    // Post sem hora: o kickoff provisório é 00:00 do dia, no passado, e o jogo pode estar por vir.
    const provisoria = await outraAposta(bankroll.id, "provisoria", new Date("2026-06-10T03:00:00Z"), true);
    // Jogo de antes do modo anterior: a banca media CLV nele, e a lacuna é do sistema mesmo.
    const antiga = await outraAposta(bankroll.id, "antiga", new Date("2026-05-20T20:00:00Z"));

    await editarBankroll(bankroll.id, { sharpMode: "CLV_ONLY" });
    await runClosingSyncOnce({ query: fakeQuery, now: NOW });

    const closing = await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(closing).toMatchObject({ clvReliable: false, noOddsReason: motivo });
    expect(closing.fetchedAt).not.toBeNull();
    expect(foraDaBaseDeCobertura(closing.noOddsReason)).toBe(true);
    // O jogo por vir, o de kickoff provisório e o de antes do modo anterior não
    // ganham o motivo: seguem o caminho comum do fechamento.
    expect(await db.prisma.betClosing.count({ where: { betId: { in: [futura.id, provisoria.id, antiga.id] } } })).toBe(0);
  });

  it("troca em cadeia IDENTITY_ONLY → OFF → CLV_ONLY: cada jogo fica com o motivo do modo em que foi jogado", async () => {
    const { bankroll, bet: jogadaSoIdentidade } = await seedSettledScenario({ sharpMode: "IDENTITY_ONLY" });
    await db.prisma.bankroll.update({
      where: { id: bankroll.id },
      data: { sharpModeChangedAt: new Date("2026-06-01T00:00:00Z") },
    });
    await editarBankroll(bankroll.id, { sharpMode: "OFF" });
    // A banca desligada desde o dia 11: o jogo do dia 12 foi jogado nela.
    await db.prisma.bankroll.update({
      where: { id: bankroll.id },
      data: { sharpModeChangedAt: new Date("2026-06-11T00:00:00Z") },
    });
    const jogadaDesligada = await outraAposta(bankroll.id, "desligada", new Date("2026-06-12T20:00:00Z"));

    await editarBankroll(bankroll.id, { sharpMode: "CLV_ONLY" });

    expect(await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: jogadaSoIdentidade.id } }))
      .toMatchObject({ clvReliable: false, noOddsReason: "identity_only" });
    expect(await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: jogadaDesligada.id } }))
      .toMatchObject({ clvReliable: false, noOddsReason: "sharp_off" });
  });

  it("seleção irreconhecível: clvReliable=false, mas evidência incompleta não ingere placar", async () => {
    const { bet } = await seedSettledScenario({ selecao: "Time Fantasma XYZ" });
    const result = await runClosingSyncOnce({ query: fakeQuery, now: NOW });
    expect(result.closed).toBe(0);

    const closing = await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(closing.clvReliable).toBe(false);
    // Motivo persistido — o painel explica o "—" em vez de deixar o dono adivinhar.
    expect(closing.noOddsReason).toBe("ambiguous_selection");
    expect(await db.prisma.betResult.count({ where: { betId: bet.id } })).toBe(0);

    const still = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(still.status).toBe("PENDING");

    // O closing é single-shot mesmo quando a linha não resolve. Resultado é
    // responsabilidade do FlashScore e não reabre a consulta sharp.
    const second = await runClosingSyncOnce({ query: fakeQuery, now: NOW });
    expect(second.processed).toBe(0);
  });

  it("kickoff no futuro não é elegível", async () => {
    const { bet } = await seedSettledScenario();
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: { data: new Date("2026-06-20T20:00:00Z") },
    });
    const result = await runClosingSyncOnce({ query: fakeQuery, now: NOW });
    expect(result.processed).toBe(0);
  });

  it("breaker aberto não conta como falha nem queima o lote", async () => {
    const { CircuitOpenError } = await import("@/src/infra/circuit-breaker");
    await seedSettledScenario({ selecao: "Birmingham Legion" });
    const open: typeof fakeQuery = async () => {
      throw new CircuitOpenError("bridgeodds");
    };
    const result = await runClosingSyncOnce({ query: open, now: NOW });
    expect(result.failures).toBe(0);
    expect(result.processed).toBe(1);
  });

  it("falha de provider numa aposta não aborta o lote (isolamento por item)", async () => {
    await seedSettledScenario({ selecao: "Birmingham Legion" });
    const flaky: typeof fakeQuery = async () => {
      throw new Error("provider caiu");
    };
    const result = await runClosingSyncOnce({ query: flaky, now: NOW });
    expect(result.failures).toBe(1);
    expect(result.processed).toBe(1);
    // fetchedAt continua null → próximo ciclo re-tenta naturalmente.
    expect(await db.prisma.betClosing.count()).toBe(0);
  });

  it("≥50% falhas com ≥3 processados → throw (fail-loud)", async () => {
    for (const selecao of ["A1", "A2", "A3"]) {
      const bankroll = await db.prisma.bankroll.create({
        data: {
          nome: `BD ${selecao}`,
          slug: `bd-fail-${selecao}`,
          valorUnidade: 100,
          sharpMode: "CLV_ONLY",
        },
      });
      await db.prisma.bet.create({
        data: {
          sportResolutionStatus: "CONFIRMED",
          sportResolvedAt: new Date(),
          settledAt: null,
          bankrollId: bankroll.id,
          data: new Date("2026-06-10T20:00:00Z"),
          evento: "Birmingham Legion vs Corpus Christi",
          esporte: "Soccer",
          mercado: "Moneyline",
          selecao,
          odds: 1.5,
          stake: 1,
          status: "PENDING",
          sharp: {
            create: {
              identityStatus: "MATCHED",
              provider: "bridgeodds",
              providerMatchId: String(birmingham.match_id),
              confidence: 90,
            },
          },
        },
      });
    }
    const flaky: typeof fakeQuery = async () => {
      throw new Error("provider morto");
    };
    await expect(runClosingSyncOnce({ query: flaky, now: NOW })).rejects.toThrow(
      /taxa de falha crítica/,
    );
  });

  it("fast-path por providerMatchId: re-localiza por id com 1 filtro/dia (≤3 queries), não a estratégia completa", async () => {
    const { bet } = await seedSettledScenario();

    const calls: Array<{ filters?: { home?: string; away?: string } }> = [];
    const spyQuery = async (params: {
      date: string;
      sport: string;
      filters?: { home?: string; away?: string };
    }) => {
      calls.push({ filters: params.filters });
      return [birmingham];
    };

    const result = await runClosingSyncOnce({ query: spyQuery, now: NOW });

    // Resolveu pelo id e capturou o CLV sem promover o placar do payload.
    expect(result).toMatchObject({ processed: 1, closed: 1, failures: 0 });
    const pending = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(pending.status).toBe("PENDING");

    // O fast-path consulta no MÁXIMO 3 vezes (janela [d0, d0+1, d0-1]) e SEMPRE
    // com filtro `home` único — nunca os ramos `{away}`-only / `{home,away}` da
    // estratégia completa (que somariam até 9 chamadas). O 1º dia que acha o id
    // encerra, então na prática é 1 chamada aqui.
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(calls.every((c) => typeof c.filters?.home === "string" && c.filters?.away === undefined)).toBe(true);
  });

  it("o id que a Bridge não devolve recebe o prazo da aposta em cada consulta", async () => {
    await seedSettledScenario();
    const deadlines: Array<number | undefined> = [];
    const startedAt = Date.now();
    const result = await runClosingSyncOnce({
      query: async (params) => { deadlines.push(params.deadlineMs); return []; },
      now: NOW,
    });

    expect(result).toMatchObject({ processed: 1, closed: 0, failures: 0 });
    // A cascata por id (3 dias, com e sem filtro) sai toda com o mesmo prazo.
    expect(deadlines.slice(0, 6).every((deadline) => deadline === deadlines[0])).toBe(true);
    expect(deadlines[0]! - startedAt).toBeGreaterThan(0);
    expect(deadlines[0]! - startedAt).toBeLessThanOrEqual(2 * 60_000 + 5_000);
  });

  it("rodada com o sinal abortado adia a aposta sem consultar o provider", async () => {
    await seedSettledScenario();
    let consultas = 0;
    const result = await runClosingSyncOnce({
      query: async () => { consultas += 1; return [birmingham]; },
      now: NOW,
      signal: AbortSignal.abort(),
    });

    expect(result).toMatchObject({ processed: 1, closed: 0, failures: 0, adiadas: 1 });
    expect(consultas).toBe(0);
    expect(await db.prisma.betClosing.count()).toBe(0);
  });

  it("sem providerMatchId: pula o fast-path e cai na estratégia completa (ainda fecha)", async () => {
    // Sem id salvo, o guard `if (providerMatchId)` pula o fast-path; a estratégia
    // completa (similaridade) resolve e fecha — confirma que o fallback segue ok.
    const { bet } = await seedSettledScenario();
    await db.prisma.betSharp.update({ where: { betId: bet.id }, data: { providerMatchId: null } });
    const result = await runClosingSyncOnce({ query: fakeQuery, now: NOW });
    expect(result).toMatchObject({ processed: 1, closed: 1 });
    const pending = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(pending.status).toBe("PENDING");
  });
});

describe("writeClosingOnce", () => {
  /** A aposta como a consulta ao provider a leu, com a identidade. */
  const lida = (betId: string) => db.prisma.bet.findUniqueOrThrow({ where: { id: betId }, include: { sharp: true } });

  it("nao cria closing nem quebra para aposta removida ou inexistente", async () => {
    const { bet } = await seedSettledScenario();
    const leitura = await lida(bet.id);
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: { deletedAt: new Date(), status: "CANCELED", settledAt: new Date() },
    });

    await expect(
      writeClosingOnce(leitura, "fetchedAt", { fetchedAt: NOW }),
    ).resolves.toBe(false);
    await expect(
      writeClosingOnce({ ...leitura, id: "00000000-0000-0000-0000-000000000000" }, "fetchedAt", { fetchedAt: NOW }),
    ).resolves.toBe(false);
    await expect(db.prisma.betClosing.count()).resolves.toBe(0);
  });

  it("não grava o CLV calculado com a odd de antes de uma edição", async () => {
    // A edição da odd no meio da consulta mantém a aposta; a escrita atrasada
    // não pode gravar o CLV da odd antiga.
    const { bet } = await seedSettledScenario();
    const leitura = await lida(bet.id);
    await db.prisma.betClosing.deleteMany({ where: { betId: bet.id } });
    const oddLida = toNumber(bet.odds);
    await db.prisma.bet.update({ where: { id: bet.id }, data: { odds: oddLida + 0.5 } });

    await expect(
      writeClosingOnce(leitura, "fetchedAt", { fetchedAt: NOW }, { expectedOdds: oddLida }),
    ).resolves.toBe(false);
    await expect(
      writeClosingOnce(leitura, "fetchedAt", { fetchedAt: NOW }, { expectedOdds: oddLida + 0.5 }),
    ).resolves.toBe(true);
  });

  it.each([
    ["a seleção", { selecao: "Corpus Christi" }],
    ["o evento", { evento: "Outro A vs Outro B" }],
    ["o kickoff", { data: new Date("2026-06-10T22:00:00Z") }],
  ])("não recria o fechamento da aposta que mudou %s depois da leitura", async (_campo, mudanca) => {
    const { bet } = await seedSettledScenario();
    const leitura = await lida(bet.id);
    await db.prisma.bet.update({ where: { id: bet.id }, data: mudanca });

    await expect(writeClosingOnce(leitura, "fetchedAt", { fetchedAt: NOW })).resolves.toBe(false);
    await expect(db.prisma.betClosing.count()).resolves.toBe(0);
  });

  it("não grava na aposta casada de novo com outro jogo depois da leitura", async () => {
    const { bet } = await seedSettledScenario();
    const leitura = await lida(bet.id);
    await db.prisma.betSharp.update({ where: { betId: bet.id }, data: { providerMatchId: "999" } });

    await expect(writeClosingOnce(leitura, "fetchedAt", { fetchedAt: NOW })).resolves.toBe(false);
    await expect(writeClosingOnce(await lida(bet.id), "fetchedAt", { fetchedAt: NOW })).resolves.toBe(true);
  });
});


it.each(["Moneyline Including OT", "Draw No Bet Including OT", "Total Including OT"])("fechamento %s não grava CLV contra o livro dos 90 minutos", async mercado => {
  const { bet } = await seedSettledScenario({ mercado, selecao: mercado.startsWith("Total") ? "Over 2.5" : birmingham.home });
  const eligible = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id }, select: eligibleBetSelect });
  expect(await processBridgeClv(eligible, birmingham, NOW)).toBe(false);
  const closing = await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } });
  expect(closing).toMatchObject({ closingOdd: null, closingRawOdd: null, clv: null, clvReliable: false,
    noOddsReason: "unsupported_market" });
  expect(await db.prisma.betOpening.count({ where: { betId: bet.id } })).toBe(0);
});
