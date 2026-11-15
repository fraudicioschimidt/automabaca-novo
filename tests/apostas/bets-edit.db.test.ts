import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, settleRaceAgainst, type TestDb } from "../helpers/db";
import { applyBetEdit, StaleSportResolutionError, type ApplyBetEditFields } from "@/src/services/bets/edit";
import { persistCandidates } from "@/src/services/bets/sport-resolution/persistence";
import { BetRemovedError } from "@/src/services/bets/settle";
import { applyManualBetStatusChange as applyBetStatusChange } from "../helpers/settle";
import { toNumber } from "@/src/domain/money";
import { percentualContraFair } from "@/src/domain/odds";
import { recomputePriceSnapshot, singlePriceSnapshot } from "@/src/domain/price-provenance";
import { parseStoredLegs } from "@/src/domain/bet-legs";
import { MERCADOS_FINAIS } from "@/src/domain/mercados/catalog";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";

/**
 * Edição in-place: os mesmos tetos de sanidade do registro (fora do plausível
 * rejeita antes da transação, sem gravar), reversão de ledger, pernas,
 * identidade e reabertura da liquidação.
 */

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

/** A revisão da aposta que uma ficha aberta agora mostraria ao dono. */
async function currentVersion(betId: string): Promise<number> {
  return (await db.prisma.bet.findUniqueOrThrow({ where: { id: betId }, select: { manualSettlementVersion: true } })).manualSettlementVersion;
}

const baseFields: ApplyBetEditFields = {
  data: new Date("2026-06-15T18:00:00Z"),
  evento: "Time A vs Time B",
  esporte: "Soccer",
  competicao: "Liga Teste",
  pais: "BR",
  mercado: "Moneyline",
  selecao: "Time A",
  odds: 2.0,
  stake: 1,
};

async function seedBet() {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: "Edit", slug: "edit", valorUnidade: 100, sharpMode: "OFF" },
  });
  return db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      settledAt: null,
      bankrollId: bankroll.id,
      data: new Date("2026-06-12T18:00:00Z"),
      evento: "Velho vs Antigo",
      esporte: "Soccer",
      competicao: "Liga",
      pais: "BR",
      mercado: "Moneyline",
      selecao: "Velho",
      odds: 1.8,
      stake: 1,
      status: "PENDING",
      source: "test",
      sourceExternalId: "edit-1",
    },
  });
}

describe("applyBetEdit — tetos de sanidade", () => {
  it("edição válida aplica os campos novos", async () => {
    const bet = await seedBet();
    await applyBetEdit({ betId: bet.id, fields: { ...baseFields, odds: 2.5 }, actor: "test" });
    const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(toNumber(after.odds)).toBe(2.5);
    expect(after.evento).toBe("Time A vs Time B");
    expect(after.status).toBe("PENDING");
  });

  it("edição comum preserva o placar live capturado como snapshot", async () => {
    const bet = await seedBet();
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: { liveScoreHome: 1, liveScoreAway: 0 },
    });
    await applyBetEdit({
      betId: bet.id,
      fields: { ...baseFields, mercado: "Asian Handicap", selecao: "Time B +0.25" },
      actor: "test",
    });

    const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(after).toMatchObject({ liveScoreHome: 1, liveScoreAway: 0 });
  });

  it("edição de captura pode preencher placar live ausente uma única vez", async () => {
    const bet = await seedBet();
    await applyBetEdit({
      betId: bet.id,
      fields: {
        ...baseFields,
        mercado: "Asian Handicap",
        selecao: "(1-0) Time B +0.25",
      },
      actor: "telegram-edit",
    });
    const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(after).toMatchObject({
      selecao: "Time B +0.25",
      liveScoreHome: 1,
      liveScoreAway: 0,
    });

    await expect(applyBetEdit({
      betId: bet.id,
      fields: {
        ...baseFields,
        mercado: "Asian Handicap",
        selecao: "(2-0) Time B +0.25",
      },
      actor: "telegram-edit",
    })).rejects.toThrow(/placar live.*imutável/i);
  });

  it("não dispara queries concorrentes no client da transação Prisma", async () => {
    const bet = await seedBet();
    const warnings = vi.spyOn(process, "emitWarning");
    try {
      await applyBetEdit({
        betId: bet.id,
        fields: { ...baseFields, odds: 2.4 },
        actor: "test:query-sequencial",
      });
      expect(warnings.mock.calls.some(([warning]) =>
        String(warning).includes("client.query() when the client is already executing a query")
      )).toBe(false);
    } finally {
      warnings.mockRestore();
    }
  });

  it("editar aposta resolvida volta a PENDING e LIMPA settledAt", async () => {
    const bet = await seedBet();
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "test" });
    expect(
      (await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).settledAt,
    ).toBeInstanceOf(Date);
    await applyBetEdit({ betId: bet.id, fields: { ...baseFields, odds: 2.2 }, actor: "test" });
    const editada = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(editada.status).toBe("PENDING");
    expect(editada.settledAt).toBeNull();
  });

  it("reabertura pelo painel grava manual:<usuário> e não cai como escrita sem autor", async () => {
    const { checkEscritasForaDoFluxo } = await import("@/src/services/ops/consistency/escritas-fora-do-fluxo");
    await db.prisma.authSessionState.create({ data: { username: "fabricio", epoch: 1n } });
    const bet = await seedBet();
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "manual:fabricio" });
    await applyBetEdit({
      betId: bet.id, fields: { ...baseFields, odds: 2.2 }, actor: "fabricio", financialAuthority: "operator",
      expectedVersion: await currentVersion(bet.id),
    });

    const reabertura = await db.prisma.settlementEvent.findFirstOrThrow({
      where: { betId: bet.id, payload: { path: ["to"], equals: "PENDING" } },
    });
    expect(reabertura.payload).toMatchObject({ from: "WON", source: "manual:fabricio" });
    expect((await checkEscritasForaDoFluxo(new Date(Date.now() + 60_000))).escritas).toEqual([]);
  });

  it("confirmar o esporte não transforma o placar ao vivo \"(1x2)\" em mercado do tempo regulamentar", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Hóquei", slug: "hoquei", valorUnidade: 100, sharpMode: "OFF" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "PENDING", settledAt: null, bankrollId: bankroll.id,
        data: new Date("2026-06-12T18:00:00Z"), evento: "Rangers vs Bruins", esporte: "Unknown",
        competicao: "NHL", pais: "USA", mercado: "Money Line", selecao: "Rangers (1x2)",
        liveScoreHome: 1, liveScoreAway: 2, odds: 2.4, stake: 1, status: "PENDING",
        source: "test", sourceExternalId: "hoquei-1",
      },
    });

    await applyBetEdit({
      betId: bet.id, actor: "sport-resolver",
      fields: {
        data: bet.data, evento: bet.evento, esporte: "Ice Hockey", competicao: bet.competicao, pais: bet.pais,
        mercado: bet.mercado, selecao: bet.selecao, odds: 2.4, stake: 1,
      },
      sportResolution: { expectedVersion: bet.manualSettlementVersion, status: "CONFIRMED", source: "TEAM_ID",
        confidence: 100, evidence: { selected: "Ice Hockey" }, resolverVersion: 1 },
    });

    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).mercado).toBe("Money Line");
  });

  it("odds acima do teto rejeita e NÃO altera a aposta", async () => {
    const bet = await seedBet();
    await expect(
      applyBetEdit({ betId: bet.id, fields: { ...baseFields, odds: 9999 }, actor: "test" }),
    ).rejects.toThrow(/teto de sanidade/);
    const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(toNumber(after.odds)).toBe(1.8); // intacto
    expect(after.evento).toBe("Velho vs Antigo");
  });

  it("stake acima do teto rejeita", async () => {
    const bet = await seedBet();
    await expect(
      applyBetEdit({ betId: bet.id, fields: { ...baseFields, stake: 5000 }, actor: "test" }),
    ).rejects.toThrow(/teto de sanidade/);
  });

  it("aposta removida falha com BetRemovedError, sem gravar", async () => {
    const bet = await seedBet();
    await db.prisma.bet.update({
      where: { id: bet.id },
      data: { deletedAt: new Date() },
    });
    await expect(
      applyBetEdit({ betId: bet.id, fields: { ...baseFields, odds: 2.2 }, actor: "test" }),
    ).rejects.toBeInstanceOf(BetRemovedError);
    const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(toNumber(after.odds)).toBe(1.8);
  });

  it("kickoff fora da janela de ±400 dias rejeita (ano absurdo num edit de canal)", async () => {
    const bet = await seedBet();
    await expect(
      applyBetEdit({
        betId: bet.id,
        fields: { ...baseFields, data: new Date("2099-01-01T00:00:00Z") },
        actor: "test",
      }),
    ).rejects.toThrow(/janela/);
    const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(after.data.getUTCFullYear()).toBe(2026); // intacto
  });
});

describe("applyBetEdit — horário a confirmar", () => {
  // A tip sem hora guarda o instante do post: é a âncora da busca de horário.
  const post = new Date("2026-06-12T21:40:00Z");
  const meiaNoiteSp = (day: string) => new Date(`${day}T03:00:00Z`);
  async function seedInferida() {
    const bet = await seedBet();
    return db.prisma.bet.update({ where: { id: bet.id }, data: { data: post, kickoffInferido: true } });
  }
  const kickoff = (id: string) => db.prisma.bet.findUniqueOrThrow({ where: { id }, select: { data: true, kickoffInferido: true } });

  it("corrigir a odd sem informar a hora mantém o instante gravado, ainda a confirmar", async () => {
    const bet = await seedInferida();
    await applyBetEdit({ betId: bet.id, fields: { ...baseFields, data: meiaNoiteSp("2026-06-12"), kickoffInferido: true, odds: 2.5 }, actor: "test" });
    expect(await kickoff(bet.id)).toEqual({ data: post, kickoffInferido: true });
  });

  it("trocar o dia sem hora leva ao novo dia, ainda a confirmar", async () => {
    const bet = await seedInferida();
    await applyBetEdit({ betId: bet.id, fields: { ...baseFields, data: meiaNoiteSp("2026-06-13"), kickoffInferido: true }, actor: "test" });
    expect(await kickoff(bet.id)).toEqual({ data: meiaNoiteSp("2026-06-13"), kickoffInferido: true });
  });

  it("a hora informada confirma o horário", async () => {
    const bet = await seedInferida();
    const informado = new Date("2026-06-12T23:00:00Z");
    await applyBetEdit({ betId: bet.id, fields: { ...baseFields, data: informado, kickoffInferido: false }, actor: "test" });
    expect(await kickoff(bet.id)).toEqual({ data: informado, kickoffInferido: false });
  });

  it("a trilha da edição guarda o horário de antes e o de depois", async () => {
    const bet = await seedInferida();
    const informado = new Date("2026-06-12T23:00:00Z");
    await applyBetEdit({ betId: bet.id, fields: { ...baseFields, data: informado, kickoffInferido: false }, actor: "test" });
    const edicao = await db.prisma.auditEvent.findFirstOrThrow({ where: { resourceId: bet.id, action: "bet.edit" } });
    expect(edicao.details).toMatchObject({
      antes: { data: post.toISOString(), kickoffInferido: true },
      depois: { data: informado.toISOString(), kickoffInferido: false },
    });
  });

  it("horário confirmado não volta a ficar a confirmar: sem a hora, a edição é recusada", async () => {
    const bet = await seedBet();
    await expect(applyBetEdit({ betId: bet.id, fields: { ...baseFields, data: meiaNoiteSp("2026-06-12"), kickoffInferido: true }, actor: "test" }))
      .rejects.toThrow(new RecusaDeNegocioError("Informe o horário."));
    expect(await kickoff(bet.id)).toEqual({ data: bet.data, kickoffInferido: false });
  });
});

describe("applyBetEdit — correção da leitura pelo dono", () => {
  const reader = { kind: "llm", provider: "mistral", model: "mistral-ocr-2512", endpoint: "ocr", contractVersion: "bet-extraction-v2" };
  const same = { ...baseFields, evento: "Velho vs Antigo", selecao: "Velho", odds: 1.8, stake: 1 };
  /** Aposta capturada com os termos já no vocabulário gravado, como sai do registro. */
  const captured = async (captureReader: object | null = reader, fields: ApplyBetEditFields = same) => {
    const bet = await seedBet();
    await applyBetEdit({ betId: bet.id, fields, actor: "sport-resolver" });
    if (captureReader) await db.prisma.bet.update({ where: { id: bet.id }, data: { captureReader } });
    return bet;
  };
  const corrections = () => db.prisma.auditEvent.findMany({ where: { action: "capture.reading_corrected" } });
  const byOwner = async (betId: string, fields: ApplyBetEditFields) =>
    applyBetEdit({ betId, fields, actor: "dono", financialAuthority: "operator", expectedVersion: await currentVersion(betId) });

  it("grava o leitor e os campos mudados, sem o texto do post", async () => {
    const bet = await captured();
    await byOwner(bet.id, { ...same, odds: 1.95, stake: 2 });
    const [event, ...rest] = await corrections();
    expect(rest).toHaveLength(0);
    expect(event).toMatchObject({ actor: "dono", resource: "bet", resourceId: bet.id, details: { reader, fields: ["odds", "stake"] } });
    expect(Object.keys(event?.details as object).sort()).toEqual(["fields", "reader"]);
  });

  it("separa a linha da seleção", async () => {
    const total = { ...same, mercado: "Total", selecao: "Over 2.5" };
    const bet = await captured(reader, total);
    await byOwner(bet.id, { ...total, selecao: "Over 3.5" });
    expect((await corrections())[0]?.details).toMatchObject({ fields: ["linha"] });
  });

  it("leitor por regra também é medido", async () => {
    const bet = await captured({ kind: "rule" });
    await byOwner(bet.id, { ...same, evento: "Novo vs Antigo" });
    expect((await corrections())[0]?.details).toMatchObject({ reader: { kind: "rule" }, fields: ["evento"] });
  });

  it("stake definida pela banca não é erro de leitura; a odd continua sendo", async () => {
    const bet = await captured();
    await db.prisma.bet.update({ where: { id: bet.id }, data: { captureStakeSnapshot: {
      version: 1, stakePolicy: "ALWAYS", defaultStakeUnits: 1, originalStake: null, source: "bankroll_fixed", basis: "CAPTURE" } } });
    await byOwner(bet.id, { ...same, odds: 1.95, stake: 2 });
    expect((await corrections())[0]?.details).toMatchObject({ fields: ["odds"] });
  });

  it("não conta edição do sistema", async () => {
    const bet = await captured();
    await applyBetEdit({ betId: bet.id, fields: { ...same, odds: 1.95 }, actor: "sport-resolver" });
    expect(await corrections()).toHaveLength(0);
  });

  it("não conta aposta sem leitor (digitada no painel ou pela DM)", async () => {
    const bet = await captured(null);
    await byOwner(bet.id, { ...same, odds: 1.95 });
    expect(await corrections()).toHaveLength(0);
  });

  it("não conta edição que não mexe na leitura nem troca só caixa e acento", async () => {
    const bet = await captured();
    await byOwner(bet.id, { ...same, evento: "VELHO vs antigo", data: new Date("2026-06-16T18:00:00Z") });
    expect(await corrections()).toHaveLength(0);
  });
});

describe("applyBetEdit — reversão de ledger", () => {
  async function seedComConta() {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "EditLedger", slug: "edit-ledger", valorUnidade: 100, sharpMode: "OFF" },
    });
    const conta = await db.prisma.conta.create({
      data: { casaDeAposta: "Bet365", titular: "Fabricio", saldoInicial: 1000, saldoAtual: 1000 },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: bankroll.id,
        contaId: conta.id,
        data: new Date("2026-06-12T18:00:00Z"),
        evento: "Velho vs Antigo",
        esporte: "Soccer",
        competicao: "Liga",
        pais: "BR",
        mercado: "Moneyline",
        selecao: "Velho",
        odds: 2.0,
        stake: 1,
        status: "PENDING",
        source: "test",
        sourceExternalId: "edit-ledger-1",
      },
    });
    return { conta, bet };
  }

  async function saldoDe(contaId: string): Promise<number> {
    const conta = await db.prisma.conta.findUniqueOrThrow({
      where: { id: contaId },
      select: { saldoAtual: true },
    });
    return toNumber(conta.saldoAtual);
  }

  it("editar aposta resolvida COM conta estorna o ganho (saldo volta ao inicial)", async () => {
    const { conta, bet } = await seedComConta();
    // Liquida WON: saldo 1000 → 1100.
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "test" });
    expect(await saldoDe(conta.id)).toBe(1100);

    // Editar volta a PENDING e DEVE estornar o ganho da versão antiga.
    await applyBetEdit({ betId: bet.id, fields: { ...baseFields, odds: 2.2 }, actor: "test" });
    expect(await saldoDe(conta.id)).toBe(1000);

    const editada = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(editada.status).toBe("PENDING");
    expect(toNumber(editada.lucro)).toBe(0);

    // Sem GANHO órfão: ledger fecha em líquido zero (GANHO_APOSTA + ESTORNO).
    const movs = await db.prisma.movimentacao.findMany({ where: { betId: bet.id } });
    expect(movs.map((m) => m.tipo).sort()).toEqual(["ESTORNO", "GANHO_APOSTA"]);
    const soma = movs.reduce((s, m) => s + toNumber(m.valor), 0);
    expect(Math.round(soma * 100) / 100).toBe(0);
  });

  it("trocar a casa estorna na conta antiga e vincula a conta correta", async () => {
    const { conta: contaAntiga, bet } = await seedComConta();
    const contaNova = await db.prisma.conta.create({
      data: {
        casaDeAposta: "Betano",
        titular: "Fabricio",
        saldoInicial: 700,
        saldoAtual: 700,
      },
    });
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "test" });
    expect(await saldoDe(contaAntiga.id)).toBe(1100);

    await applyBetEdit({
      betId: bet.id,
      fields: { ...baseFields, casaDeAposta: "Betano" },
      actor: "test",
    });

    const editada = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(editada.contaId).toBe(contaNova.id);
    expect(editada.casaDeAposta).toBe("Betano");
    expect(await saldoDe(contaAntiga.id)).toBe(1000);
    expect(await saldoDe(contaNova.id)).toBe(700);
  });

  it("voltar à odd da captura após re-MATCHED reabre e estorna o ledger", async () => {
    const { conta, bet } = await seedComConta();
    await db.prisma.betCaptureEvidence.create({
      data: {
        betId: bet.id,
        parser: "universal",
        parsedJson: {
          evento: bet.evento,
          mercado: bet.mercado,
          selecao: bet.selecao,
          odds: 1.9,
          stake: 1,
        },
        expiresAt: new Date("2026-12-31T00:00:00Z"),
      },
    });
    await db.prisma.betSharp.create({
      data: { betId: bet.id, identityStatus: "MATCHED", confidence: 95 },
    });
    // Estado alcançável após A→B→enrich: a captura diz A=1.90, a aposta atual
    // já está em B=2.00 e voltou a MATCHED antes de ser liquidada.
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "test" });
    expect(await saldoDe(conta.id)).toBe(1100);

    const result = await applyBetEdit({
      betId: bet.id,
      actor: "telegram-edit",
      fields: {
        data: bet.data,
        evento: bet.evento,
        esporte: bet.esporte,
        competicao: bet.competicao,
        pais: bet.pais,
        mercado: bet.mercado,
        selecao: bet.selecao,
        odds: 1.9,
        stake: 1,
        casaDeAposta: bet.casaDeAposta,
      },
    });

    const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(result).toEqual({
      requiresEnrich: true,
      identityPreserved: false,
      settlementPreserved: false,
    });
    expect(after.status).toBe("PENDING");
    expect(toNumber(after.odds)).toBe(1.9);
    expect(toNumber(after.lucro)).toBe(0);
    expect(after.settledAt).toBeNull();
    expect(await saldoDe(conta.id)).toBe(1000);
  });
});

describe("applyBetEdit — training case", () => {
  it("expira training OPEN no edit substancial", async () => {
    const bet = await seedBet();
    await db.prisma.trainingCase.create({
      data: {
        betId: bet.id,
        evento: bet.evento,
        esporte: bet.esporte,
        status: "OPEN",
        candidatesJson: [],
        autoScore: 0,
      },
    });
    await applyBetEdit({ betId: bet.id, fields: { ...baseFields, odds: 2.1 }, actor: "test" });
    const tcase = await db.prisma.trainingCase.findFirstOrThrow({ where: { betId: bet.id } });
    expect(tcase.status).toBe("EXPIRED");
  });
});

describe("applyBetEdit — ticket", () => {
  it("preserva legs explícitas quando apenas a odd muda e o texto não é reparseável", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Ticket opaco", slug: "ticket-opaco", valorUnidade: 100, sharpMode: "OFF" },
    });
    const legsJson = {
      kind: "parlay",
      legs: [
        { evento: "France vs Morocco", mercado: "Moneyline", selecao: "France" },
        { evento: "Spain vs Italy", mercado: "Total", selecao: "Under 2.5" },
      ],
    } as const;
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: bankroll.id,
        data: baseFields.data,
        evento: "Dupla especial",
        esporte: "Soccer",
        competicao: "Liga",
        pais: "FIFA",
        mercado: "Moneyline",
        selecao: "Seleções confirmadas",
        odds: 2,
        stake: 1,
        status: "PENDING",
        source: "test",
        sourceExternalId: "edit-opaque-legs",
        legsJson,
      },
    });

    await applyBetEdit({
      betId: bet.id,
      actor: "test",
      fields: {
        ...baseFields,
        evento: "Dupla especial",
        competicao: "Liga",
        pais: "FIFA",
        selecao: "Seleções confirmadas",
        odds: 2.1,
      },
    });
    const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(after.legsJson).toEqual(legsJson);
  });

  it("recusa mudança estrutural opaca sem novas legs explícitas", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Ticket bloqueado", slug: "ticket-bloqueado", sharpMode: "OFF" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        data: baseFields.data,
        evento: "Dupla especial",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "Seleções confirmadas",
        odds: 2,
        stake: 1,
        source: "test",
        sourceExternalId: "edit-blocked-legs",
        legsJson: {
          kind: "parlay",
          legs: [
            { evento: "France vs Morocco", mercado: "Moneyline", selecao: "France" },
            { evento: "Spain vs Italy", mercado: "Total", selecao: "Under 2.5" },
          ],
        },
      },
    });
    await expect(applyBetEdit({
      betId: bet.id,
      actor: "test",
      fields: { ...baseFields, evento: "Outra dupla", selecao: "Outra seleção" },
    })).rejects.toThrow(/legsJson válido/i);
  });

  it("recalcula legsJson quando o tipster muda o texto da dupla", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Ticket", slug: "ticket-edit", valorUnidade: 100, sharpMode: "OFF" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: bankroll.id,
        data: baseFields.data,
        evento: "France vs Morocco | Spain vs Italy",
        esporte: "Soccer",
        competicao: "Liga",
        pais: "FIFA",
        mercado: "Moneyline",
        selecao: "France / Spain",
        odds: 2,
        stake: 1,
        status: "PENDING",
        source: "test",
        sourceExternalId: "edit-legs",
        legsJson: {
          kind: "parlay",
          legs: [
            { evento: "France vs Morocco", mercado: "Moneyline", selecao: "France" },
            { evento: "Spain vs Italy", mercado: "Moneyline", selecao: "Spain" },
          ],
        },
      },
    });

    await applyBetEdit({
      betId: bet.id,
      actor: "test",
      fields: {
        ...baseFields,
        evento: "France vs Morocco | Spain vs Italy",
        competicao: "Liga",
        pais: "FIFA",
        selecao: "France ML / U 2.5",
      },
    });

    const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(after.legsJson).toMatchObject({
      kind: "parlay",
      legs: [
        expect.objectContaining({ evento: "France vs Morocco", selecao: "France" }),
        expect.objectContaining({ evento: "Spain vs Italy", selecao: "Under 2.5" }),
      ],
    });
    const legs = parseStoredLegs(after.legsJson);
    expect(legs).not.toBeNull();
    expect(legs?.legs.every((leg) => MERCADOS_FINAIS.includes(leg.mercado as never)))
      .toBe(true);
  });
});

describe("applyBetEdit — identidade", () => {
  it("preserva identidade e fechamento em correção conservadora de alias", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Alias", slug: "alias", sharpMode: "CLV_ONLY" },
    });
    const data = new Date("2026-06-15T18:00:00Z");
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        data,
        evento: "Adelaide Blue Eagles vs Adelaide Cobras",
        esporte: "Soccer",
        mercado: "Handicap – Match",
        selecao: "Adelaide Cobras +1.25",
        odds: 1.975,
        stake: 1,
        sharp: {
          create: {
            identityStatus: "MATCHED",
            confidence: 95,
            provider: "bridgeodds",
            providerMatchId: "1632466033",
            noOddsReason: "clv_only",
          },
        },
        closing: {
          create: {
            closingOdd: 1.9,
            closingRawOdd: 1.95,
            closingPriceSnapshot: {
              version: 1,
              combination: "single",
              components: [{ lineQ: 1.25, rawOdds: [1.95, 1.95], selectedIndex: 0, devig: "power" }],
            },
            closingPriceReference: "bridgeodds:v1:1632466033",
            closingPriceObservedAt: data,
            provider: "bridgeodds",
            clv: 2.5,
            clvReliable: true,
          },
        },
      },
    });

    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "test" });
    const settledBefore = await db.prisma.bet.findUniqueOrThrow({
      where: { id: bet.id },
      select: { settledAt: true },
    });

    const result = await applyBetEdit({
      betId: bet.id,
      actor: "test",
      fields: {
        data,
        evento: "Blue Eagles vs Adelaide Cobras",
        esporte: "Soccer",
        competicao: "",
        pais: "",
        mercado: "Asian Handicap",
        selecao: "Adelaide Cobras +1.25",
        odds: 1.975,
        stake: 1,
      },
    });

    const sharp = await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(sharp).toMatchObject({
      identityStatus: "MATCHED",
      provider: "bridgeodds",
      providerMatchId: "1632466033",
    });
    expect(await db.prisma.betClosing.findUnique({ where: { betId: bet.id } })).not.toBeNull();
    const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(after.evento).toBe("Adelaide Blue Eagles vs Adelaide Cobras");
    expect(after.status).toBe("WON");
    expect(after.settledAt).toEqual(settledBefore.settledAt);
    expect(result).toEqual({
      requiresEnrich: false,
      identityPreserved: true,
      settlementPreserved: true,
    });
  });

  it("mudança de competição invalida identidade e reabre a aposta", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Competicao", slug: "competicao", sharpMode: "CLV_ONLY" },
    });
    const data = new Date("2026-06-15T18:00:00Z");
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        data,
        evento: "Time A vs Time B",
        esporte: "Soccer",
        competicao: "Liga A",
        pais: "BR",
        mercado: "Moneyline",
        selecao: "Time A",
        odds: 2,
        stake: 1,
        sharp: { create: { identityStatus: "MATCHED", confidence: 95 } },
      },
    });
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "test" });

    const result = await applyBetEdit({
      betId: bet.id,
      actor: "test",
      fields: {
        data,
        evento: "Time A vs Time B",
        esporte: "Soccer",
        competicao: "Liga B",
        pais: "BR",
        mercado: "Moneyline",
        selecao: "Time A",
        odds: 2,
        stake: 1,
      },
    });

    const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(after.status).toBe("PENDING");
    expect(after.settledAt).toBeNull();
    expect(result).toEqual({
      requiresEnrich: true,
      identityPreserved: false,
      settlementPreserved: false,
    });
  });

  it("invalida identidade quando o confronto realmente muda", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Mudanca", slug: "mudanca", sharpMode: "CLV_ONLY" },
    });
    const data = new Date("2026-06-15T18:00:00Z");
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        data,
        evento: "Time A vs Time B",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "Time A",
        odds: 2,
        stake: 1,
        sharp: { create: { identityStatus: "MATCHED", confidence: 95 } },
        closing: {
          create: {
            closingOdd: 1.98,
            closingRawOdd: 2,
            closingPriceSnapshot: {
              version: 1,
              combination: "single",
              components: [{ lineQ: null, rawOdds: [2, 2], selectedIndex: 0, devig: "power" }],
            },
            closingPriceReference: "bridgeodds:v1:test-mudanca",
            closingPriceObservedAt: data,
            provider: "bridgeodds",
            clv: 1,
            clvReliable: true,
          },
        },
      },
    });

    await applyBetEdit({
      betId: bet.id,
      actor: "test",
      fields: {
        data,
        evento: "Outro A vs Outro B",
        esporte: "Soccer",
        competicao: "",
        pais: "",
        mercado: "Moneyline",
        selecao: "Time A",
        odds: 2,
        stake: 1,
      },
    });

    expect(await db.prisma.betSharp.findUnique({ where: { betId: bet.id } })).toBeNull();
    expect(await db.prisma.betClosing.findUnique({ where: { betId: bet.id } })).toBeNull();
  });

  it("inversão home-away é estrutural porque muda a semântica da seleção", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Orientacao", slug: "orientacao", sharpMode: "CLV_ONLY" },
    });
    const data = new Date("2026-06-15T18:00:00Z");
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        data,
        evento: "Time A vs Time B",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "Time A",
        odds: 2,
        stake: 1,
        sharp: { create: { identityStatus: "MATCHED", confidence: 95 } },
        closing: {
          create: {
            closingOdd: 1.98,
            closingRawOdd: 2,
            closingPriceSnapshot: {
              version: 1,
              combination: "single",
              components: [{ lineQ: null, rawOdds: [2, 2], selectedIndex: 0, devig: "power" }],
            },
            closingPriceReference: "bridgeodds:v1:test-orientacao",
            closingPriceObservedAt: data,
            provider: "bridgeodds",
            clv: 1,
            clvReliable: true,
          },
        },
      },
    });

    const result = await applyBetEdit({
      betId: bet.id,
      actor: "test",
      fields: {
        data,
        evento: "Time B vs Time A",
        esporte: "Soccer",
        competicao: "",
        pais: "",
        mercado: "Moneyline",
        selecao: "Time A",
        odds: 2,
        stake: 1,
      },
    });

    expect(result).toEqual({
      requiresEnrich: true,
      identityPreserved: false,
      settlementPreserved: false,
    });
    expect(await db.prisma.betSharp.findUnique({ where: { betId: bet.id } })).toBeNull();
    expect(await db.prisma.betClosing.findUnique({ where: { betId: bet.id } })).toBeNull();
  });

  describe("edição que repete o que a captura leu", () => {
    const KICKOFF = new Date("2026-06-15T18:00:00Z");
    const lido = { evento: "Flamengo vs Palmeiras", mercado: "Total – Match", selecao: "Over 2.5", odds: 1.9, stake: 1 };
    const doPainel = (override: Partial<ApplyBetEditFields> = {}): ApplyBetEditFields => ({
      data: KICKOFF, esporte: "Soccer", competicao: "Serie A", pais: "Brazil", ...lido, ...override,
    });

    /** A aposta capturada como `lido`, já com os termos atuais e MATCHED. */
    async function seedCaptured(atual: { evento?: string; selecao?: string }) {
      const bankroll = await db.prisma.bankroll.create({
        data: { nome: "Captura", slug: "captura-lida", valorUnidade: 100, sharpMode: "CLV_ONLY" },
      });
      return db.prisma.bet.create({
        data: {
          sportResolutionStatus: "CONFIRMED",
          sportResolvedAt: new Date(),
          bankrollId: bankroll.id,
          data: KICKOFF,
          esporte: "Soccer",
          competicao: "Serie A",
          pais: "Brazil",
          ...lido,
          ...atual,
          sharp: { create: { identityStatus: "MATCHED", confidence: 95, provider: "bridgeodds", providerMatchId: "222" } },
          captureEvidence: { create: { parser: "universal", parsedJson: lido, expiresAt: new Date("2026-12-31T00:00:00Z") } },
        },
      });
    }
    const editar = async (betId: string, fields: ApplyBetEditFields) =>
      applyBetEdit({ betId, fields, actor: "dono", financialAuthority: "operator", expectedVersion: await currentVersion(betId) });

    it("voltar a seleção à da captura depois de outro MATCHED grava a seleção, reabre e refaz a identidade", async () => {
      const bet = await seedCaptured({ selecao: "Over 3.5" });
      await applyBetStatusChange({ betId: bet.id, newStatus: "LOST", source: "test" });

      const result = await editar(bet.id, doPainel());

      expect(result).toEqual({ requiresEnrich: true, identityPreserved: false, settlementPreserved: false });
      const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
      expect(after).toMatchObject({ selecao: "Over 2.5", status: "PENDING", settledAt: null });
      expect(toNumber(after.lucro)).toBe(0);
      expect(await db.prisma.betSharp.findUnique({ where: { betId: bet.id } })).toBeNull();
    });

    it("voltar ao evento do post depois de casar outro jogo grava o evento e apaga o casamento", async () => {
      const bet = await seedCaptured({ evento: "Flamengo vs Corinthians" });

      const result = await editar(bet.id, doPainel());

      expect(result.identityPreserved).toBe(false);
      expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).evento).toBe("Flamengo vs Palmeiras");
      expect(await db.prisma.betSharp.findUnique({ where: { betId: bet.id } })).toBeNull();
    });

    it("mudar só a competição de aposta capturada grava a competição e pede o enrich", async () => {
      const bet = await seedCaptured({});

      const result = await editar(bet.id, doPainel({ competicao: "Copa do Brasil" }));

      expect(result).toMatchObject({ requiresEnrich: true, identityPreserved: false });
      expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).competicao).toBe("Copa do Brasil");
    });
  });

  it("invalidates settlement and resets status to PENDING when odds change on a settled bet", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Edit Settlement", slug: "edit-settle", valorUnidade: 100, sharpMode: "OFF" },
    });
    const data = new Date("2026-06-15T18:00:00Z");
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        data,
        evento: "Time A vs Time B",
        esporte: "Soccer",
        competicao: "Liga",
        pais: "BR",
        mercado: "Moneyline",
        selecao: "Time A",
        odds: 2.0,
        stake: 1,
        status: "WON",
        lucro: 1.0,
        settledAt: new Date(),
        source: "test",
        sourceExternalId: "edit-settle-1",
        sharp: { create: { identityStatus: "MATCHED", confidence: 95 } },
      },
    });

    const result = await applyBetEdit({
      betId: bet.id,
      actor: "test",
      fields: {
        data,
        evento: "Time A vs Time B",
        esporte: "Soccer",
        competicao: "Liga",
        pais: "BR",
        mercado: "Moneyline",
        selecao: "Time A",
        odds: 2.5, // changed odds!
        stake: 1,
      },
    });

    expect(result.settlementPreserved).toBe(false);
    const updated = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(updated.status).toBe("PENDING");
    expect(toNumber(updated.lucro)).toBe(0);
    expect(updated.settledAt).toBeNull();
    expect(toNumber(updated.odds)).toBe(2.5);
  });
});

describe("applyBetEdit — correção só de odd, stake ou casa depois do jogo", () => {
  const KICKOFF = new Date("2026-06-15T18:00:00Z");
  const termos = {
    data: KICKOFF, evento: "Time A vs Time B", esporte: "Soccer", competicao: "Liga", pais: "Brazil",
    mercado: "Total – Match", selecao: "Over 2.5",
  };
  const REFERENCIA = "pinnacle17:v1:1633447577:0:total:10:over";
  const snapshot = (rawOdds: [number, number]) => ({
    version: 1, combination: "single", components: [{ lineQ: 10, rawOdds, selectedIndex: 0, devig: "power" }],
  });

  /** Aposta WON, casada pela Pinnacle17, com fechamento congelado, abertura e placar final. */
  async function seedFechada() {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Preco", slug: "edit-preco", valorUnidade: 100, sharpMode: "CLV_ONLY" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        ...termos,
        odds: 1.95,
        stake: 2,
        sharp: { create: { identityStatus: "MATCHED", confidence: 95, provider: "pinnacle17", providerMatchId: "1633447577" } },
        closing: {
          create: {
            closingOdd: 1.8,
            closingRawOdd: 1.8,
            closingPriceSnapshot: snapshot([1.8, 2.25]),
            closingPriceReference: REFERENCIA,
            closingPriceObservedAt: new Date(KICKOFF.getTime() - 60_000),
            provider: "pinnacle17",
            clv: 8.3333,
            clvReliable: true,
            source: "CRON",
            fetchedAt: KICKOFF,
          },
        },
        opening: {
          create: {
            provider: "pinnacle17", priceReference: REFERENCIA, openingOdd: 1.9, openingRawOdd: 1.95,
            openingPriceSnapshot: snapshot([1.95, 1.95]), openingPriceObservedAt: new Date(KICKOFF.getTime() - 86_400_000),
            attempts: 1,
          },
        },
        result: {
          create: {
            resultProvider: "flashscore", resultMatchId: "fs-1", scoreHome: 3, scoreAway: 1,
            resultFinal: true, resultCheckedAt: new Date(KICKOFF.getTime() + 2 * 3_600_000),
          },
        },
      },
    });
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "test" });
    return bet;
  }
  /** Sem `expectedVersion`, a ficha foi aberta agora. */
  const editar = async (betId: string, override: Partial<ApplyBetEditFields>, expectedVersion?: number) => applyBetEdit({
    betId, actor: "dono", financialAuthority: "operator", expectedVersion: expectedVersion ?? await currentVersion(betId),
    fields: { ...termos, odds: 1.95, stake: 2, ...override },
  });
  const evidencia = async (betId: string) => ({
    sharp: await db.prisma.betSharp.findUnique({ where: { betId } }),
    closing: await db.prisma.betClosing.findUnique({ where: { betId } }),
    opening: await db.prisma.betOpening.findUnique({ where: { betId } }),
    result: await db.prisma.betResult.findUnique({ where: { betId } }),
  });
  const snapshotOf = async (betId: string) => ({
    bet: await db.prisma.bet.findUniqueOrThrow({ where: { id: betId } }),
    ...await evidencia(betId),
    events: await db.prisma.settlementEvent.findMany({ where: { betId } }),
  });

  it("a ficha aberta antes da liquidação não corrige a aposta: a edição é recusada e nada muda", async () => {
    // A ficha abriu com a aposta ainda pendente; a liquidação chegou depois.
    const bet = await seedFechada();
    const antes = await snapshotOf(bet.id);
    expect(antes.bet.status).toBe("WON");

    await expect(editar(bet.id, { odds: 1.9 }, bet.manualSettlementVersion)).rejects.toThrow(RecusaDeNegocioError);

    expect(await snapshotOf(bet.id)).toEqual(antes);
  });

  it("a ficha aberta antes do casamento não devolve os termos velhos nem apaga o fechamento", async () => {
    const bet = await seedFechada();
    const aberta = await currentVersion(bet.id);
    // O casamento com o fornecedor troca evento e competição enquanto a ficha está aberta.
    await db.prisma.bet.update({ where: { id: bet.id }, data: { evento: "Time A FC vs Time B FC", competicao: "Liga Pro" } });
    const antes = await snapshotOf(bet.id);

    await expect(editar(bet.id, { odds: 1.9 }, aberta)).rejects.toThrow(/mudou desde que a ficha abriu/);

    expect(await snapshotOf(bet.id)).toEqual(antes);
  });

  it("a stake corrigida mantém identidade, fechamento e abertura, e reabre a liquidação pelo mesmo jogo", async () => {
    const bet = await seedFechada();
    const antes = await evidencia(bet.id);

    const result = await editar(bet.id, { stake: 1 });

    expect(result).toEqual({ requiresEnrich: false, identityPreserved: true, settlementPreserved: false });
    const depois = await evidencia(bet.id);
    expect(depois.sharp).toEqual(antes.sharp);
    expect(depois.closing).toEqual(antes.closing);
    expect(depois.opening).toEqual(antes.opening);
    // O vínculo do jogo fica, e o placar volta a ser lido para a nova liquidação.
    expect(depois.result).toMatchObject({ resultMatchId: "fs-1", resultFinal: false, scoreHome: null, resultCheckedAt: null });
    const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(after).toMatchObject({ status: "PENDING", settledAt: null });
    expect(toNumber(after.stake)).toBe(1);
    expect(toNumber(after.lucro)).toBe(0);
  });

  it("a odd corrigida refaz o CLV sobre o mesmo fechamento", async () => {
    const bet = await seedFechada();
    const antes = await evidencia(bet.id);

    const result = await editar(bet.id, { odds: 1.9 });

    expect(result).toEqual({ requiresEnrich: false, identityPreserved: true, settlementPreserved: false });
    const depois = await evidencia(bet.id);
    expect(depois.sharp).toEqual(antes.sharp);
    expect(depois.opening).toEqual(antes.opening);
    expect(depois.closing).toMatchObject({ clvReliable: true, provider: "pinnacle17", fetchedAt: KICKOFF });
    expect(toNumber(depois.closing?.closingOdd)).toBe(1.8);
    expect(toNumber(depois.closing?.clv)).toBeCloseTo((1.9 / 1.8 - 1) * 100, 3);
  });

  it("editar e devolver a odd recompõe o mesmo CLV com a precisão do book original", async () => {
    const bet = await seedFechada();
    const price = singlePriceSnapshot({ rawOdds: [1.91, 1.87], selectedIndex: 0, devig: "power", lineQ: 10 });
    const quote = recomputePriceSnapshot(price)!;
    const initialClv = Number(percentualContraFair(1.95, quote.fair)!.toFixed(4));
    await db.prisma.betClosing.update({ where: { betId: bet.id }, data: {
      closingOdd: quote.fair, closingRawOdd: quote.raw, closingPriceSnapshot: price, clv: initialClv,
    } });
    await editar(bet.id, { odds: 2 });
    expect(toNumber((await evidencia(bet.id)).closing?.clv)).toBe(-1.1524);
    await editar(bet.id, { odds: 1.95 });
    expect(toNumber((await evidencia(bet.id)).closing?.clv)).toBe(initialClv);
    expect((await evidencia(bet.id)).closing?.closingPriceSnapshot).toEqual(price);
  });

  it("corrigir a odd não fabrica CLV quando o snapshot não prova o fechamento", async () => {
    const bet = await seedFechada();
    await db.prisma.betClosing.update({ where: { betId: bet.id }, data: {
      closingPriceSnapshot: { version: 1, combination: "single", components: [] },
    } });
    await editar(bet.id, { odds: 1.9 });
    expect((await evidencia(bet.id)).closing).toMatchObject({ clv: null, clvReliable: false });
  });

  it("a casa corrigida mantém identidade, fechamento e abertura", async () => {
    const bet = await seedFechada();
    const antes = await evidencia(bet.id);

    const result = await editar(bet.id, { casaDeAposta: "Betano" });

    expect(result).toEqual({ requiresEnrich: false, identityPreserved: true, settlementPreserved: false });
    const depois = await evidencia(bet.id);
    expect(depois.sharp).toEqual(antes.sharp);
    expect(depois.closing).toEqual(antes.closing);
    expect(depois.opening).toEqual(antes.opening);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).casaDeAposta).toBe("Betano");
  });
});

describe("applyBetEdit — reabertura", () => {
  const KICKOFF = new Date("2026-08-14T18:00:00Z");

  it("a reabertura trava a aposta antes de estornar a conta, como a liquidação: as duas não fecham ciclo", async () => {
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Ordem", slug: "edit-ordem", valorUnidade: 100 } });
    const conta = await db.prisma.conta.create({ data: { casaDeAposta: "Bet365", titular: "Fabricio", saldoInicial: 1000, saldoAtual: 1000 } });
    const bet = await db.prisma.bet.create({ data: {
      sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(), bankrollId: bankroll.id, contaId: conta.id, data: KICKOFF,
      evento: "Time A vs Time B", esporte: "Soccer", competicao: "Liga", pais: "BR", mercado: "Moneyline", selecao: "Time A",
      odds: 2, stake: 1, casaDeAposta: "Bet365",
    } });
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "test" });

    await settleRaceAgainst({ betId: bet.id, contaId: conta.id }, () => applyBetEdit({
      betId: bet.id, actor: "test",
      fields: { data: KICKOFF, evento: bet.evento, esporte: "Soccer", competicao: "Liga", pais: "BR", mercado: "Moneyline",
        selecao: "Time A", odds: 2.2, stake: 1, casaDeAposta: "Bet365" },
    }));

    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ status: "PENDING", settledAt: null });
    expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(1000);
  });

  it("reabre settlement e estorna o ledger mesmo quando os termos batem com a captura", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Esporte", slug: "edit-esporte", valorUnidade: 100 },
    });
    const conta = await db.prisma.conta.create({
      data: {
        casaDeAposta: "Bet365",
        titular: "Fabricio",
        saldoInicial: 1000,
        saldoAtual: 1000,
      },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        contaId: conta.id,
        data: KICKOFF,
        evento: "Time A vs Time B",
        esporte: "Soccer",
        competicao: "Liga",
        pais: "BR",
        mercado: "Moneyline",
        selecao: "Time A",
        odds: 2,
        stake: 1,
        casaDeAposta: "Bet365",
        sharp: {
          create: {
            identityStatus: "MATCHED",
            confidence: 95,
            provider: "bridgeodds",
            providerMatchId: "fixture-soccer",
          },
        },
        result: { create: { scoreHome: 1, scoreAway: 0, resultFinal: true } },
        captureEvidence: {
          create: {
            parser: "universal",
            parsedJson: {
              evento: "Time A vs Time B",
              mercado: "Moneyline",
              selecao: "Time A",
              odds: 2,
              stake: 1,
            },
            expiresAt: new Date("2026-12-31T00:00:00Z"),
          },
        },
      },
    });
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "test" });
    expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual))
      .toBe(1100);

    const result = await applyBetEdit({
      betId: bet.id,
      actor: "test:sport-edit",
      fields: {
        data: KICKOFF,
        evento: "Time A vs Time B",
        esporte: "Basketball",
        competicao: "Liga",
        pais: "BR",
        mercado: "Moneyline",
        selecao: "Time A",
        odds: 2,
        stake: 1,
        casaDeAposta: "Bet365",
      },
    });

    const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(after).toMatchObject({
        esporte: "Basketball",
        status: "PENDING",
        settledAt: null,
    });
    expect(toNumber(after.lucro)).toBe(0);
    expect(result).toEqual({
      requiresEnrich: true,
      identityPreserved: false,
      settlementPreserved: false,
    });
    expect(await db.prisma.betSharp.findUnique({ where: { betId: bet.id } })).toBeNull();
    expect(await db.prisma.betClosing.findUnique({ where: { betId: bet.id } })).toBeNull();
    expect(await db.prisma.betResult.findUnique({ where: { betId: bet.id } })).toBeNull();
    expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual))
      .toBe(1000);
  });

  it("grava SettlementEvent ao reabrir aposta liquidada", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Banca Edit Event", slug: "edit-event" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        bankrollId: bankroll.id,
        evento: "Galo vs Cruzeiro",
        esporte: "Futebol",
        competicao: "Mineiro",
        pais: "Brasil",
        mercado: "Match Odds",
        selecao: "Galo",
        odds: 2.10,
        stake: 1.0,
        status: "PENDING",
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        data: new Date(),
        registradoEm: new Date(),
      },
    });

    // Liquida manualmente como WON
    await applyBetStatusChange({
      betId: bet.id,
      newStatus: "WON",
      source: "operator",
    });

    const settledBet = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(settledBet.status).toBe("WON");

    // Edição material reabre a aposta para PENDING (!preserveSettlement)
    await applyBetEdit({
      betId: bet.id,
      fields: {
        evento: "Galo vs Cruzeiro",
        competicao: "Mineiro",
        pais: "Brasil",
        mercado: "Total de Gols",
        selecao: "Mais de 2.5", // Mudança estrutural de mercado/seleção
        odds: 2.10,
        stake: 1.0,
        data: bet.data,
        esporte: "Futebol",
      },
      actor: "tipster-edit",
    });

    const reopenedBet = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(reopenedBet.status).toBe("PENDING");

    // Verifica se o SettlementEvent foi gravado com from: "WON", to: "PENDING"
    const settlementEvents = await db.prisma.$queryRawUnsafe<
      Array<{ id: string; betId: string; type: string; payload: { from: string; to: string; source: string } }>
    >(`SELECT "id", "betId", "type", "payload" FROM "settlement_events" WHERE "betId" = $1 ORDER BY "createdAt" ASC`, bet.id);

    const reopenEvent = settlementEvents.find(
      (e) => e.payload.from === "WON" && e.payload.to === "PENDING",
    );
    expect(reopenEvent).toBeDefined();
    expect(reopenEvent?.payload.source).toBe("tipster-edit");
  });
});

describe("primeiro placar live em edição (PostgreSQL real)", () => {
  it("preserva a identidade, mas reabre settlement e invalida preço prematch", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: {
        nome: "Live edit",
        slug: "live-edit",
        valorUnidade: 100,
        sharpMode: "CLV_ONLY",
        vincularContas: true,
      },
    });
    const conta = await db.prisma.conta.create({
      data: {
        casaDeAposta: "Bet365",
        titular: "Fabricio",
        saldoInicial: 1_000,
        saldoAtual: 1_000,
        bankrollLinks: { create: { bankrollId: bankroll.id } },
      },
    });
    const data = new Date("2026-08-12T20:00:00Z");
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        contaId: conta.id,
        data,
        evento: "Time A vs Time B",
        esporte: "Soccer",
        competicao: "Liga",
        pais: "Brazil",
        mercado: "Handicap – Match",
        selecao: "Time B +0.25",
        odds: 2,
        stake: 1,
        valorUnidade: 100,
        casaDeAposta: "Bet365",
        sharp: {
          create: {
            identityStatus: "MATCHED",
            confidence: 98,
            provider: "bridgeodds",
            providerMatchId: "match-live-1",
          },
        },
        closing: {
          create: {
            closingOdd: 1.85,
            closingRawOdd: 1.9,
            clv: 8.1081,
            clvReliable: true,
            fetchedAt: new Date("2026-08-12T20:00:05Z"),
          },
        },
        result: { create: { scoreHome: 1, scoreAway: 1 } },
      },
    });
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "test" });
    expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual))
      .toBe(1_100);

    const result = await applyBetEdit({
      betId: bet.id,
      actor: "telegram-edit",
      fields: {
        data,
        evento: "Time A vs Time B",
        esporte: "Soccer",
        competicao: "Liga",
        pais: "BR",
        mercado: "Handicap – Match",
        selecao: "(1-0) Time B +0.25",
        odds: 2,
        stake: 1,
        casaDeAposta: "Bet365",
      },
    });

    expect(result).toEqual({
      requiresEnrich: false,
      identityPreserved: true,
      settlementPreserved: false,
    });
    const edited = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(edited).toMatchObject({
        status: "PENDING",
        settledAt: null,
        selecao: "Time B +0.25",
        liveScoreHome: 1,
        liveScoreAway: 0,
      });
    expect(toNumber(edited.lucro)).toBe(0);
    expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual))
      .toBe(1_000);
    expect(await db.prisma.betClosing.findUniqueOrThrow({ where: { betId: bet.id } }))
      .toMatchObject({ closingOdd: null, clv: null, clvReliable: null, fetchedAt: null });
    expect(await db.prisma.betResult.findUniqueOrThrow({ where: { betId: bet.id } }))
      .toMatchObject({ scoreHome: null, scoreAway: null, resultFinal: false });
    expect(await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } }))
      .toMatchObject({
        identityStatus: "MATCHED",
        provider: "bridgeodds",
        providerMatchId: "match-live-1",
        noOddsReason: "aposta_ao_vivo",
      });
  });
});

describe("applyBetEdit — decisão do resolvedor de esporte", () => {
  async function seed() {
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Guard esporte", slug: "sport-guard", valorUnidade: 100, vincularContas: true } });
    const conta = await db.prisma.conta.create({ data: { casaDeAposta: "Bet365", titular: "Sintetico", saldoInicial: 0, saldoAtual: 0,
      bankrollLinks: { create: { bankrollId: bankroll.id } } } });
    const bet = await db.prisma.bet.create({ data: { bankrollId: bankroll.id, contaId: conta.id, valorUnidade: 100,
      data: new Date(Date.now() - 86_400_000), evento: "Time A vs Time B", esporte: "Unknown", sportResolutionStatus: "PENDING",
      mercado: "Moneyline", selecao: "Time A", odds: 2, stake: 1, casaDeAposta: "Bet365",
      captureEvidence: { create: { parser: "universal", parsedJson: { evento: "Time A vs Time B" },
        candidatesJson: { marker: "captura" }, expiresAt: new Date(Date.now() + 86_400_000) } } } });
    return { bet, conta };
  }
  function fields(bet: Awaited<ReturnType<typeof seed>>["bet"]): ApplyBetEditFields {
    return { data: bet.data, evento: bet.evento, esporte: "Soccer", competicao: bet.competicao, pais: bet.pais,
      mercado: bet.mercado, selecao: bet.selecao, odds: toNumber(bet.odds), stake: toNumber(bet.stake),
      casaDeAposta: bet.casaDeAposta, kickoffInferido: bet.kickoffInferido };
  }
  /** Liquidada com a modalidade ainda pendente (estado que o resolvedor precisa preservar). */
  async function settleWhileSportPending(betId: string) {
    const confirmed = { esporte: "Soccer", sportResolutionStatus: "CONFIRMED" as const, sportResolvedAt: new Date() };
    await db.prisma.bet.update({ where: { id: betId }, data: confirmed });
    await applyBetStatusChange({ betId, newStatus: "WON", source: "manual:teste" });
    await db.prisma.bet.update({ where: { id: betId }, data: { esporte: "Unknown", sportResolutionStatus: "PENDING", sportResolvedAt: null } });
  }

  function resolve(bet: Awaited<ReturnType<typeof seed>>["bet"], override: Partial<ApplyBetEditFields> = {}) {
    return applyBetEdit({ betId: bet.id, actor: "sport-resolver", fields: { ...fields(bet), ...override },
      sportResolution: { expectedVersion: bet.manualSettlementVersion, status: "CONFIRMED", source: "TEAM_ID",
        confidence: 100, evidence: { selected: "Soccer" }, resolverVersion: 1 } });
  }

  it("a resposta antiga não desfaz correção já liquidada nem altera seu ledger", async () => {
    const { bet, conta } = await seed();
    await applyBetEdit({ betId: bet.id, actor: "operator:test", financialAuthority: "operator", expectedVersion: bet.manualSettlementVersion,
      fields: { ...fields(bet), evento: "Time C vs Time D", selecao: "Time C" },
      sportResolution: { status: "CONFIRMED", source: "MANUAL", confidence: 100, evidence: {}, resolverVersion: 1 } });
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "manual:test" });
    const before = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    const ledgerBefore = await db.prisma.movimentacao.findMany({ where: { betId: bet.id } });
    await expect(resolve(bet)).rejects.toBeInstanceOf(StaleSportResolutionError);
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toEqual(before);
    expect(await db.prisma.movimentacao.findMany({ where: { betId: bet.id } })).toEqual(ledgerBefore);
    expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(100);
    expect((await db.prisma.betCaptureEvidence.findUniqueOrThrow({ where: { betId: bet.id } })).candidatesJson).toEqual({ marker: "captura" });
  });

  it("rejeita versão antiga mesmo se a identidade mudou e voltou ao valor original", async () => {
    const { bet } = await seed();
    await db.prisma.bet.update({ where: { id: bet.id }, data: { evento: "Outro vs Evento" } });
    await db.prisma.bet.update({ where: { id: bet.id }, data: { evento: bet.evento } });
    await expect(resolve(bet)).rejects.toBeInstanceOf(StaleSportResolutionError);
    const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(after.sportResolutionStatus).toBe("PENDING");
    expect(after.manualSettlementVersion).toBeGreaterThan(bet.manualSettlementVersion);
  });

  it("preserva resultado e dinheiro ao apenas confirmar a modalidade dos termos vigentes", async () => {
    const { bet, conta } = await seed();
    await settleWhileSportPending(bet.id);
    const current = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    const ledgerBefore = await db.prisma.movimentacao.findMany({ where: { betId: bet.id } });
    expect(await resolve(current)).toMatchObject({ settlementPreserved: true });
    const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(after).toMatchObject({ status: "WON", esporte: "Soccer", sportResolutionStatus: "CONFIRMED", evento: bet.evento });
    expect(after.settledAt).toEqual(current.settledAt);
    expect(toNumber(after.lucro)).toBe(1);
    expect(await db.prisma.movimentacao.findMany({ where: { betId: bet.id } })).toEqual(ledgerBefore);
    expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(100);
  });

  it("a resposta que ainda vê o horário a confirmar não desfaz o horário já confirmado", async () => {
    const { bet } = await seed();
    await expect(resolve(bet, { kickoffInferido: true })).rejects.toBeInstanceOf(StaleSportResolutionError);
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id }, select: { data: true, kickoffInferido: true } }))
      .toEqual({ data: bet.data, kickoffInferido: false });
  });

  it("a versão vigente não autoriza o resolvedor a trocar a seleção consultada", async () => {
    const { bet } = await seed();
    await expect(resolve(bet, { selecao: "Time B" })).rejects.toBeInstanceOf(StaleSportResolutionError);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).selecao).toBe("Time A");
  });

  it.each(["PENDING", "CONFLICT"] as const)("descarta também evidência %s quando a aposta mudou", async (status) => {
    const { bet } = await seed();
    await db.prisma.bet.update({ where: { id: bet.id }, data: { selecao: "Time B" } });
    await expect(persistCandidates(bet, [], status, null)).rejects.toBeInstanceOf(StaleSportResolutionError);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).sportResolutionStatus).toBe("PENDING");
    expect((await db.prisma.betCaptureEvidence.findUniqueOrThrow({ where: { betId: bet.id } })).candidatesJson).toEqual({ marker: "captura" });
  });

  it("confirmar o esporte de aposta liquidada não move o horário dela", async () => {
    // O resolvedor pode achar o próximo confronto e gravar um horário futuro numa
    // aposta já GREEN; o lucro ficaria num jogo "futuro".
    const { bet } = await seed();
    await db.prisma.bet.update({ where: { id: bet.id }, data: { kickoffInferido: true } });
    await settleWhileSportPending(bet.id);
    const current = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    const futuro = new Date(Date.now() + 7 * 86_400_000);
    expect(await resolve(current, { data: futuro, kickoffInferido: false })).toMatchObject({ settlementPreserved: true });
    const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(after).toMatchObject({ status: "WON", sportResolutionStatus: "CONFIRMED", kickoffInferido: true });
    expect(after.data).toEqual(current.data);
  });
});


describe("applyBetEdit — completude do histórico", () => {
  it("o histórico registra o esporte efetivo quando uma resposta do resolvedor é preservada", async () => {
    const bet = await seedBet();
    await applyBetEdit({ betId: bet.id, actor: "sport-resolver", fields: {
      ...baseFields, data: bet.data, evento: bet.evento, mercado: bet.mercado, selecao: bet.selecao,
      pais: bet.pais, competicao: bet.competicao, odds: toNumber(bet.odds), stake: toNumber(bet.stake),
    }, sportResolution: { expectedVersion: bet.manualSettlementVersion, status: "CONFIRMED", source: "TEAM_ID",
      confidence: 95, evidence: {}, resolverVersion: 1 } });
    const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    const audit = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "bet.edit", resourceId: bet.id } });
    expect(audit.details).toMatchObject({ depois: { esporte: after.esporte, sportResolutionStatus: after.sportResolutionStatus,
      sportConfidence: after.sportConfidence, sportSource: after.sportSource } });
  });

  it("guarda país e campeonato anteriores e os efetivamente persistidos", async () => {
    const bet = await seedBet();
    await applyBetEdit({ betId: bet.id, fields: { ...baseFields, pais: "Argentina", competicao: "Liga Argentina" }, actor: "test" });
    const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    const audit = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "bet.edit", resourceId: bet.id } });
    expect(audit.details).toMatchObject({ antes: { pais: bet.pais, competicao: bet.competicao },
      depois: { pais: after.pais, competicao: after.competicao } });
  });

  it("preserva a prova e os termos financeiros do resultado invalidado pela edição", async () => {
    const bet = await seedBet();
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "manual:teste" });
    await db.prisma.betResult.create({ data: { betId: bet.id, resultProvider: "flashscore", resultMatchId: "fs-history",
      scoreHome: 2, scoreAway: 1, resultFinal: true, resultSnapshot: { placar: "2-1", stats: { corners: [6, 3] } } } });
    await applyBetEdit({ betId: bet.id, fields: { ...baseFields, odds: 2.2 }, actor: "test" });
    expect(await db.prisma.betResult.findUnique({ where: { betId: bet.id } })).toBeNull();
    const event = await db.prisma.settlementEvent.findFirstOrThrow({ where: { betId: bet.id, type: "STATUS_CHANGED", payload: { path: ["to"], equals: "PENDING" } } });
    expect(event.payload).toMatchObject({ previousLucro: 0.8, odds: 1.8, stake: 1, valorUnidade: 100,
      terms: { evento: bet.evento, mercado: bet.mercado, selecao: bet.selecao, data: bet.data.toISOString() },
      previousEvidence: { result: { resultMatchId: "fs-history", scoreHome: 2, scoreAway: 1,
        resultSnapshot: { placar: "2-1", stats: { corners: [6, 3] } } } } });
  });
});


describe("edição de termos promocionais", () => {
  it.each(["market", "leg"])("não transforma aposta em dinheiro em promoção pelo %s", async (scope) => {
    const bet = await seedBet();
    const fields = scope === "market" ? { ...baseFields, mercado: "Aposta grátis" } : { ...baseFields, legsJson: { kind: "parlay", legs: [
      { evento: "Time A vs Time B", mercado: "Moneyline", selecao: "Time A" },
      { evento: "Time C vs Time D", mercado: "Aposta grátis", selecao: "Time C" },
    ] } };
    await expect(applyBetEdit({ betId: bet.id, fields, actor: "test" })).rejects.toThrow(/promocional/i);
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toEqual(bet);
    expect(await db.prisma.movimentacao.count()).toBe(0);
  });
});


it.each(["selection", "leg"])("edição preserva aposta e dinheiro ao recusar lay no %s", async (scope) => {
  const bet = await seedBet();
  const fields = scope === "selection" ? { ...baseFields, selecao: "Lay Time A" } : { ...baseFields, legsJson: { kind: "parlay", legs: [
    { evento: "Time A vs Time B", mercado: "Moneyline", selecao: "Time A" },
    { evento: "Time C vs Time D", mercado: "Lay", selecao: "Time C" },
  ] } };
  await expect(applyBetEdit({ betId: bet.id, fields, actor: "test" })).rejects.toThrow(/contrato financeiro/i);
  expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toEqual(bet);
  expect(await db.prisma.movimentacao.count()).toBe(0);
});
