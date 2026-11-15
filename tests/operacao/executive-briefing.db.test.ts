import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "@/src/infra/env";
import { sendExecutiveBriefing } from "@/src/services/ops/digests/executive-briefing";
import type * as MatchingDayModule from "@/src/services/ops/digests/matching-day";
import { createTestDb, type TestDb } from "../helpers/db";

const matchingRead = vi.hoisted(() => ({ failure: null as Error | null }));
vi.mock("@/src/services/ops/digests/matching-day", async (importOriginal) => {
  const actual = await importOriginal<typeof MatchingDayModule>();
  return {
    ...actual,
    readMatchingDay: async (day: Parameters<typeof actual.readMatchingDay>[0]) => {
      if (matchingRead.failure) throw matchingRead.failure;
      return actual.readMatchingDay(day);
    },
  };
});

/**
 * O briefing das 00:05 lido do banco: o saldo de cada banca e o lucro em reais
 * saem da mesma conta que o painel faz (unidades × valor da unidade).
 */

let db: TestDb;
const originalToken = process.env.TELEGRAM_NOTIFICATION_BOT_TOKEN;
const originalChatId = process.env.TELEGRAM_NOTIFICATION_CHAT_ID;

beforeAll(() => {
  process.env.TELEGRAM_NOTIFICATION_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_NOTIFICATION_CHAT_ID = "123";
  resetEnvCacheForTests();
  db = createTestDb();
});

afterAll(async () => {
  if (originalToken === undefined) delete process.env.TELEGRAM_NOTIFICATION_BOT_TOKEN;
  else process.env.TELEGRAM_NOTIFICATION_BOT_TOKEN = originalToken;
  if (originalChatId === undefined) delete process.env.TELEGRAM_NOTIFICATION_CHAT_ID;
  else process.env.TELEGRAM_NOTIFICATION_CHAT_ID = originalChatId;
  resetEnvCacheForTests();
  await db.dispose();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await db.reset();
  vi.unstubAllGlobals();
  matchingRead.failure = null;
});

/** A série diária do casamento, como `docs/OBSERVABILIDADE.md` manda consultar. */
function matchingSeries() {
  return db.prisma.operationalMetric.findMany({ where: { kind: "daily", name: "matching" } });
}

/** 24/09 00:05 em São Paulo: o briefing resume o dia 23. */
const SENT_AT = new Date("2026-09-24T03:05:00Z");
const SETTLED_AT = new Date("2026-09-23T20:00:00Z");

async function sendBriefing(): Promise<string> {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  await sendExecutiveBriefing(SENT_AT);
  expect(fetchMock).toHaveBeenCalledOnce();
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return (JSON.parse(String(init.body)) as { text: string }).text;
}

function createSettledBet(bankrollId: string, over: { status: "WON" | "LOST"; stake: number; lucro: number }) {
  return db.prisma.bet.create({
    data: {
      bankrollId,
      data: new Date("2026-09-23T18:00:00Z"),
      evento: `Jogo ${over.status} ${over.stake}`,
      esporte: "Soccer",
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date("2026-09-23T12:00:00Z"),
      mercado: "Moneyline",
      selecao: "Casa",
      odds: 2,
      stake: over.stake,
      lucro: over.lucro,
      valorUnidade: 100,
      status: over.status,
      settledAt: SETTLED_AT,
    },
  });
}

describe("briefing executivo (Postgres real)", () => {
  it("a retentativa do mesmo dia não duplica o briefing com números novos; o dia seguinte entrega", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const bank = await db.prisma.bankroll.create({ data: { nome: "Alfa", slug: "alfa" } });
    await sendExecutiveBriefing(SENT_AT);
    await createSettledBet(bank.id, { status: "WON", stake: 1, lucro: 1 });
    await sendExecutiveBriefing(new Date(SENT_AT.getTime() + 300_000));
    expect(fetchMock).toHaveBeenCalledOnce();
    await sendExecutiveBriefing(new Date(SENT_AT.getTime() + 86_400_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("o saldo da banca é o capital em unidades mais o lucro, convertido pela unidade", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Canal X", slug: "canal-x", valorUnidade: 100, capitalInicial: 100 },
    });
    await db.prisma.bankroll.create({
      data: { nome: "Canal Novo", slug: "canal-novo", valorUnidade: 20, capitalInicial: 100 },
    });
    await createSettledBet(bankroll.id, { status: "WON", stake: 2, lucro: 2 });

    const text = await sendBriefing();

    expect(text).toContain("• Canal X: 102.00u · R$ 10.200,00 (+2.00u)");
    expect(text).toContain("• Canal Novo: 100.00u · R$ 2.000,00 (+0.00u)");
    expect(text).toContain("• Total: R$ 12.200,00");
  });

  it("o mês soma pelo dia do jogo; o dia, pelo que foi liquidado nele", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Canal M", slug: "canal-m", valorUnidade: 100, capitalInicial: 100 },
    });
    await createSettledBet(bankroll.id, { status: "WON", stake: 2, lucro: 2 });
    // Jogo de agosto, homologado só no dia do resumo: é resultado de agosto.
    const late = await createSettledBet(bankroll.id, { status: "WON", stake: 3, lucro: 3 });
    await db.prisma.bet.update({ where: { id: late.id }, data: { data: new Date("2026-08-31T18:00:00Z") } });

    const text = await sendBriefing();

    expect(text).toContain("No dia: +R$ 500,00");
    expect(text).toContain("Setembro até o dia: +R$ 200,00");
  });

  it("aposta cujo lançamento foi estornado sem conta nova conta o lucro dela em reais", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Canal Y", slug: "canal-y", valorUnidade: 100, capitalInicial: 100 },
    });
    const conta = await db.prisma.conta.create({
      data: { casaDeAposta: "Betano", titular: "Fabricio", saldoInicial: 0, saldoAtual: 0, status: "ENCERRADA" },
    });
    await createSettledBet(bankroll.id, { status: "WON", stake: 2, lucro: 2 });
    // Ganha na conta, corrigida para perdida com a conta encerrada: o ganho
    // foi estornado e a perda ficou sem conta. O lucro dela é −1u = −R$ 100.
    const corrected = await createSettledBet(bankroll.id, { status: "LOST", stake: 1, lucro: -1 });
    await db.prisma.movimentacao.createMany({
      data: [
        { contaId: conta.id, betId: corrected.id, tipo: "GANHO_APOSTA", valor: 100, saldoApos: 100 },
        { contaId: conta.id, betId: corrected.id, tipo: "ESTORNO", valor: -100, saldoApos: 0 },
      ],
    });

    const text = await sendBriefing();

    expect(text).toContain("No dia: +R$ 100,00");
    expect(text).toContain("• Canal Y: 101.00u · R$ 10.100,00 (+1.00u)");
  });

  it("conta os jogos do dia casados antes do início, sem os que não esperam identidade", async () => {
    const comSharp = await db.prisma.bankroll.create({
      data: { nome: "Canal Z", slug: "canal-z", valorUnidade: 100, capitalInicial: 100 },
    });
    const semSharp = await db.prisma.bankroll.create({
      data: { nome: "Canal Off", slug: "canal-off", valorUnidade: 100, capitalInicial: 100, sharpMode: "OFF" },
    });
    const kickoff = new Date("2026-09-23T22:00:00Z");
    const antes = new Date("2026-09-23T15:00:00Z");
    const depois = new Date("2026-09-23T23:00:00Z");
    const aposta = async (nome: string, over: {
      bankrollId?: string;
      data?: Date;
      kickoffInferido?: boolean;
      registradoEm?: Date;
      sharp?: { identityStatus: "MATCHED" | "PENDING" | "UNSUPPORTED"; identityResolvedAt?: Date; noOddsReason?: string };
    } = {}) => {
      const bet = await db.prisma.bet.create({
        data: {
          bankrollId: over.bankrollId ?? comSharp.id,
          data: over.data ?? kickoff,
          kickoffInferido: over.kickoffInferido ?? false,
          registradoEm: over.registradoEm ?? new Date("2026-09-23T12:00:00Z"),
          evento: `${nome} vs Rival`,
          esporte: "Soccer",
          sportResolutionStatus: "CONFIRMED",
          sportResolvedAt: antes,
          mercado: "Moneyline",
          selecao: "Casa",
          odds: 2,
          stake: 1,
          valorUnidade: 100,
          status: "PENDING",
        },
      });
      if (over.sharp) await db.prisma.betSharp.create({ data: { betId: bet.id, ...over.sharp } });
    };
    await aposta("Casada antes", { sharp: { identityStatus: "MATCHED", identityResolvedAt: antes } });
    await aposta("Casada depois", { sharp: { identityStatus: "MATCHED", identityResolvedAt: depois } });
    await aposta("Nunca casou", { sharp: { identityStatus: "PENDING" } });
    await aposta("Sem cobertura", { sharp: { identityStatus: "UNSUPPORTED" } });
    await aposta("Multipla", { sharp: { identityStatus: "MATCHED", identityResolvedAt: antes, noOddsReason: "multipla" } });
    await aposta("Sem horario", { kickoffInferido: true });
    await aposta("Banca off", { bankrollId: semSharp.id });
    await aposta("Outro dia", { data: new Date("2026-09-24T12:00:00Z") });
    await aposta("Ao vivo", { registradoEm: depois, sharp: { identityStatus: "MATCHED", identityResolvedAt: depois } });

    const text = await sendBriefing();

    expect(text).toContain("• Jogos do dia casados antes do início: 1 de 3 (33%)");
    // A mesma taxa vai para a série diária do casamento.
    const [row] = await matchingSeries();
    expect(row?.labels).toMatchObject({ identityBeforeKickoff: { matched: 1, total: 3 } });
  });
});

describe("casamento do dia no resumo (Postgres real)", () => {
  async function settledByFlashscore() {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Canal W", slug: "canal-w", valorUnidade: 100, capitalInicial: 100 },
    });
    const bet = await createSettledBet(bankroll.id, { status: "WON", stake: 1, lucro: 1 });
    await db.prisma.settlementEvent.create({
      data: {
        betId: bet.id,
        type: "STATUS_CHANGED",
        payload: { from: "PENDING", to: "WON", lucro: 1, source: "flashscore", changedAt: SETTLED_AT.toISOString() },
        payloadHash: "hash-flashscore",
        createdAt: SETTLED_AT,
      },
    });
  }

  it("mostra o bloco lido do banco e grava a linha do dia antes do envio", async () => {
    await settledByFlashscore();

    const text = await sendBriefing();

    expect(text).toContain("• Caixa de ações vazia ✅\n\n🔗 Casamento\n• Liquidadas: 1 no automático\n");
    const [row] = await matchingSeries();
    expect(row?.labels).toMatchObject({ day: "2026-09-23", settled: { automatic: 1, manual: 0 } });
  });

  it("leitura do casamento que falha não derruba o resumo: sai sem o bloco e sem linha na série", async () => {
    await settledByFlashscore();
    matchingRead.failure = new Error("consulta do casamento falhou");

    const text = await sendBriefing();

    expect(text).toContain("• No dia: +R$ 100,00");
    expect(text).toContain("• Canal W: 101.00u");
    expect(text).not.toContain("Casamento");
    await expect(matchingSeries()).resolves.toEqual([]);
  });
});


it("não soma unidades diferentes no ROI nem anuncia ganho quando o dinheiro ficou negativo", async () => {
  const a = await db.prisma.bankroll.create({ data: { nome: "A", slug: "a", valorUnidade: 999 } });
  const b = await db.prisma.bankroll.create({ data: { nome: "B", slug: "b", valorUnidade: 777 } });
  const win = await createSettledBet(a.id, { stake: 2, lucro: 2, status: "WON" });
  await db.prisma.bet.update({ where: { id: win.id }, data: { valorUnidade: 10 } });
  await createSettledBet(b.id, { stake: 1, lucro: -1, status: "LOST" });
  const text = await sendBriefing();
  expect(text).toContain("No dia: -R$ 80,00 🔴");
  expect(text).toContain("ROI -66.67%");
  expect(text).toContain("Setembro até o dia: -R$ 80,00 · ROI -66.67%");
});


it("dia só com anuladas e canceladas informa ROI sem base em vez de zero", async () => {
  const bank = await db.prisma.bankroll.create({ data: { nome: "Reembolsos", slug: "reembolsos" } });
  for (const status of ["VOID", "CANCELED"] as const) await db.prisma.bet.create({ data: {
    bankrollId: bank.id, evento: `Jogo ${status}`, esporte: "Soccer", mercado: "Moneyline", selecao: "Casa",
    odds: 2, stake: 20, lucro: 0, valorUnidade: 100, status,
    data: new Date("2026-09-23T18:00:00Z"), settledAt: SETTLED_AT,
    sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date("2026-09-23T12:00:00Z"),
  } });
  const text = await sendBriefing();
  expect(text).toContain("ROI — (sem stake finalizada)");
  expect(text).toContain("2 anuladas");
  expect(text).not.toContain("ROI 0.00%");
});
