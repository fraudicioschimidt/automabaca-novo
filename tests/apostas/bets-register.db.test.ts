import { marketIncludesExtraTime } from "@/src/domain/mercados/classify";
import { providerCoversBet } from "@/src/providers/coverage";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";

/** O aviso do registro sobre a evidência fora do contrato, observado sem calar o resto do log. */
const registerLogWarn = vi.hoisted(() => vi.fn());
vi.mock("@/src/infra/logger", async (original) => {
  const real = await original<typeof import("@/src/infra/logger")>();
  return {
    ...real,
    createLogger: (mod: string) => {
      const child = real.createLogger(mod);
      if (mod === "bet-register") child.warn = registerLogWarn as unknown as typeof child.warn;
      return child;
    },
  };
});
import { findPostSourceUse, registerBet } from "@/src/services/bets/register";
import { confirmBetSport } from "@/src/services/bets/sport-resolution/resolve";
import { purgeOldAuditEvents } from "@/src/services/ops/audit-purge";
import { softDeleteBet } from "@/src/services/bets/remove";
import { reuseSerializableTransaction, runSerializableTransaction } from "@/src/services/shared/transaction";
import { entrouAoVivo } from "@/src/domain/entrada-ao-vivo";

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

const KICKOFF = new Date("2026-06-15T19:00:00Z");

async function seedBankroll(overrides?: { vincularContas?: boolean }) {
  return db.prisma.bankroll.create({
    data: {
      nome: "Jorge Neves",
      slug: "jorge-neves",
      valorUnidade: 100,
      vincularContas: overrides?.vincularContas ?? true,
    },
  });
}

function baseInput(bankrollId: string) {
  return {
    bankrollId,
    data: KICKOFF,
    evento: "Flamengo  vs   Palmeiras", // espaços duplicados de propósito
    esporte: "Soccer",
    mercado: "Resultado Final",
    selecao: "Casa",
    odds: 2.1,
    stake: 1,
    casaDeAposta: "Betano",
    source: "telegram-channel:-100123",
    sourceExternalId: "555",
    actor: "teste",
  };
}

const opts = () => ({ client: db.prisma });

describe("registerBet (Postgres real)", () => {
  it("preserva os termos iniciais normalizados após expirar a evidência de captura", async () => {
    const bankroll = await seedBankroll();
    const postedAt = new Date("2026-06-15T10:00:00Z");
    const result = await registerBet({ ...baseInput(bankroll.id), pais: "BR", competicao: "Brasileirão",
      sourcePostedAt: postedAt, captureEvidence: { parser: "gemini", parsed: {} } }, opts());
    const initial = await db.prisma.bet.findUniqueOrThrow({ where: { id: result.betId } });
    await db.prisma.betCaptureEvidence.update({ where: { betId: initial.id }, data: { expiresAt: new Date(0) } });
    await db.prisma.bet.update({ where: { id: initial.id }, data: { data: new Date("2026-06-16T19:00:00Z"), pais: "AR", competicao: "Outra liga" } });
    await purgeOldAuditEvents();
    expect(await db.prisma.betCaptureEvidence.count()).toBe(0);
    const audit = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "bet.create", resourceId: initial.id } });
    expect(audit.details).toMatchObject({ data: KICKOFF.toISOString(), esporte: initial.esporte,
      pais: initial.pais, competicao: initial.competicao, casaDeAposta: initial.casaDeAposta,
      valorUnidade: 100, sourceExternalId: "555", sourcePostedAt: postedAt.toISOString(),
      evento: initial.evento, mercado: initial.mercado, selecao: initial.selecao });
  });

  it("preserva no histórico as pernas efetivas da múltipla", async () => {
    const bankroll = await seedBankroll();
    const result = await registerBet({ ...baseInput(bankroll.id),
      evento: "Flamengo vs Palmeiras / Spain vs Italy", selecao: "Flamengo / Spain" }, opts());
    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: result.betId } });
    expect(bet.legsJson).not.toBeNull();
    const audit = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "bet.create", resourceId: bet.id } });
    expect(audit.details).toMatchObject({ legsJson: bet.legsJson });
  });

  it("preserva no histórico o contrato e a regra inicial da prop de jogador", async () => {
    const bankroll = await seedBankroll();
    const result = await registerBet({ ...baseInput(bankroll.id), mercado: "Player Shots", selecao: "Tom Fellows Over 1.5" }, opts());
    const prop = await db.prisma.betPlayerProp.findUniqueOrThrow({ where: { betId: result.betId } });
    const audit = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "bet.create", resourceId: result.betId } });
    expect(audit.details).toMatchObject({ playerProp: { terms: prop.terms, rule: prop.rule } });
  });

  it("preserva apostas de modalidades distintas com os mesmos clubes e termos", async () => {
    const bankroll = await seedBankroll();
    const input = { ...baseInput(bankroll.id), evento: "Barcelona vs Real Madrid", mercado: "Money Line – 1st Half", selecao: "Barcelona" };
    const soccer = await registerBet(input, opts());
    const basketball = await registerBet({ ...input, esporte: "Basketball", sourceExternalId: "556" }, opts());
    expect(soccer.created).toBe(true);
    expect(basketball.created).toBe(true);
    expect(basketball.betId).not.toBe(soccer.betId);
    const repeated = await registerBet({ ...input, esporte: "Basketball", sourceExternalId: "557" }, opts());
    expect(repeated.created).toBe(false);
    expect(repeated.betId).toBe(basketball.betId);
  });
  it("normaliza tudo para o vocabulário Pinnacle ao persistir", async () => {
    const bankroll = await seedBankroll();
    const result = await registerBet(baseInput(bankroll.id), opts());

    expect(result.created).toBe(true);
    expect(result.mercadoMatched).toBe(true);

    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: result.betId } });
    expect(bet.evento).toBe("Flamengo vs Palmeiras"); // espaços colapsados
    expect(bet.mercado).toBe("Money Line – Match"); // rótulo final de Soccer na Pinnacle
    expect(bet.selecao).toBe("Flamengo"); // "Casa" → nome real do time
    expect(bet.tipster).toBe("Jorge Neves"); // default = nome do bankroll
    expect(bet.status).toBe("PENDING");

    const audit = await db.prisma.auditEvent.findMany({
      where: { action: "bet.create", resourceId: bet.id },
    });
    expect(audit).toHaveLength(1);
  });

  it("persiste o bilhete Bet365 de remates do Time 1 com lado e linha", async () => {
    const bankroll = await seedBankroll();
    const result = await registerBet({
      ...baseInput(bankroll.id),
      evento: "Santos vs Macara",
      mercado: "Time 1 - Remates",
      selecao: "Santos - Menos de 21.5",
      casaDeAposta: "Bet365",
    }, opts());
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: result.betId } }))
      .resolves.toMatchObject({
        mercado: "Team Total (Shots) – Match",
        selecao: "Santos Under 21.5",
      });
  });

  it("deriva o lado do Time 2 quando a seleção traz somente a linha", async () => {
    const bankroll = await seedBankroll();
    const result = await registerBet({
      ...baseInput(bankroll.id),
      evento: "Santos vs Macara",
      mercado: "Time 2 - Remates",
      selecao: "Menos de 18.5",
      casaDeAposta: "Bet365",
    }, opts());
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: result.betId } }))
      .resolves.toMatchObject({
        mercado: "Team Total (Shots) – Match",
        selecao: "Macara Under 18.5",
      });
  });

  it.each([
    ["Time da Casa - Remates", "Santos"],
    ["Time Visitante - Remates", "Macara"],
    ["Home Team - Shots", "Santos"],
    ["Away Team - Shots", "Macara"],
  ])("preserva lado nos aliases PT/EN de casa e visitante: %s", async (mercado, team) => {
    const bankroll = await seedBankroll();
    const result = await registerBet({
      ...baseInput(bankroll.id),
      evento: "Santos vs Macara",
      mercado,
      selecao: "Under 20.5",
      casaDeAposta: "Bet365",
    }, opts());
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: result.betId } }))
      .resolves.toMatchObject({
        mercado: "Team Total (Shots) – Match",
        selecao: `${team} Under 20.5`,
      });
  });

  it("infere Remates pelo lado da seleção e mantém total agregado distinto", async () => {
    const bankroll = await seedBankroll();
    const team = await registerBet({
      ...baseInput(bankroll.id),
      evento: "Santos vs Macara",
      mercado: "Remates",
      selecao: "Santos - Menos de 21.5",
      casaDeAposta: "Bet365",
    }, opts());
    const match = await registerBet({
      ...baseInput(bankroll.id),
      evento: "Santos vs Macara",
      mercado: "Total de Remates",
      selecao: "Menos de 39.5",
      casaDeAposta: "Bet365",
      sourceExternalId: "556",
    }, opts());
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: team.betId } }))
      .resolves.toMatchObject({
        mercado: "Team Total (Shots) – Match",
        selecao: "Santos Under 21.5",
      });
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: match.betId } }))
      .resolves.toMatchObject({
        mercado: "Total (Shots) – Match",
        selecao: "Under 39.5",
      });
  });

  it.each(["Total Shots", "Shots Total"])(
    "persiste o total do jogo pelo alias inglês: %s",
    async (mercado) => {
      const bankroll = await seedBankroll();
      const result = await registerBet({
        ...baseInput(bankroll.id),
        evento: "Santos vs Macara",
        mercado,
        selecao: "Under 39.5",
        casaDeAposta: "Bet365",
      }, opts());
      await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: result.betId } }))
        .resolves.toMatchObject({
          mercado: "Total (Shots) – Match",
          selecao: "Under 39.5",
        });
    },
  );

  it("rejeita conflito entre Time 1 do mercado e visitante na seleção", async () => {
    const bankroll = await seedBankroll();
    await expect(registerBet({
      ...baseInput(bankroll.id),
      evento: "Santos vs Macara",
      mercado: "Time 1 - Remates",
      selecao: "Macara - Menos de 21.5",
      casaDeAposta: "Bet365",
    }, opts())).rejects.toThrow(/Escopo conflitante em remates/);
  });

  it("grava na aposta quem a leu: regra, modelo da IA ou ninguém na DM", async () => {
    const bankroll = await seedBankroll();
    const reading = { provider: "gemini", model: "gemini-3.1-flash-lite", endpoint: "generate", contractVersion: "bet-extraction-v2",
      contractHash: "h", sourceHash: "s", responseHash: "r", receivedAt: "2026-06-15T12:00:00.000Z" };
    const ocrEvidence = { version: 1, state: "complete", accuracy: "unreviewed", readers: [reading], sourceFields: {}, transformations: [] };
    // Termos distintos: a mesma aposta noutro post seria a mesma linha.
    const read = async (parser: string, parsed: unknown, id: string) => {
      const result = await registerBet({ ...baseInput(bankroll.id), odds: Number(`2.${id}`), sourceExternalId: id,
        captureEvidence: { parser, caption: "tip", parsed } }, opts());
      return (await db.prisma.bet.findUniqueOrThrow({ where: { id: result.betId } })).captureReader;
    };
    expect(await read("gemini-vision", { ocrEvidence }, "601")).toEqual({
      kind: "llm", provider: "gemini", model: "gemini-3.1-flash-lite", endpoint: "generate", contractVersion: "bet-extraction-v2",
    });
    expect(await read("universal", { selecao: "Casa" }, "602")).toEqual({ kind: "rule" });
    expect(await read("groq", {}, "603")).toEqual({ kind: "llm", provider: "groq", model: null, endpoint: null, contractVersion: null });
    expect(await read("telegram-dm", {}, "604")).toBeNull();
    const manual = await registerBet({ ...baseInput(bankroll.id), odds: 2.605, sourceExternalId: "605" }, opts());
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: manual.betId } })).captureReader).toBeNull();
  });

  it("evidência fora do contrato da captura é gravada assim mesmo, e o log aponta o que destoou", async () => {
    const bankroll = await seedBankroll();
    registerLogWarn.mockClear();
    // O escritor mudou sem o contrato: um campo sumiu e outro apareceu.
    const offContract = {
      evento: "Flamengo vs Palmeiras", esporte: "Soccer", competicao: "", pais: "", mercado: "Resultado Final", selecao: "Casa",
      liveScoreHome: null, liveScoreAway: null, odds: 2.1, stake: 1, data: KICKOFF.toISOString(), casaDeAposta: "Betano",
      sportResolution: { sport: "Soccer", status: "CONFIRMED", confidence: 95, source: "EMOJI", evidence: [], resolverVersion: 14 },
      campoNovo: 1,
    };
    const result = await registerBet({ ...baseInput(bankroll.id), captureEvidence: { parser: "gemini", caption: "tip", parsed: offContract } }, opts());
    expect(result.created).toBe(true);
    expect(await db.prisma.betCaptureEvidence.findUniqueOrThrow({ where: { betId: result.betId }, select: { parsedJson: true } }))
      .toEqual({ parsedJson: offContract });
    expect(registerLogWarn).toHaveBeenCalledTimes(1);
    expect(registerLogWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventCode: "CAPTURE_EVIDENCE_OFF_CONTRACT", parser: "gemini",
      issues: [{ code: "invalid_type", path: "kickoffDateOnly" }, { code: "unrecognized_keys", path: "", keys: ["campoNovo"] }],
    }), expect.any(String));
  });

  it("persiste placar live mesmo quando só a legenda preservou o prefixo", async () => {
    const bankroll = await seedBankroll();
    const result = await registerBet({
      ...baseInput(bankroll.id),
      mercado: "Asian Handicap",
      selecao: "Palmeiras +0.25",
      captureEvidence: {
        parser: "universal",
        caption: "Entrada: (1-0) Palmeiras +0.25",
        parsed: { selecao: "Palmeiras +0.25" },
      },
    }, opts());

    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: result.betId } });
    expect(bet).toMatchObject({
      selecao: "Palmeiras +0.25",
      liveScoreHome: 1,
      liveScoreAway: 0,
    });
  });

  it("promove sufixo AH seguro da legenda e mantém a seleção financeira limpa", async () => {
    const bankroll = await seedBankroll();
    const result = await registerBet({
      ...baseInput(bankroll.id),
      mercado: "Asian Handicap",
      selecao: "Palmeiras +0.25",
      captureEvidence: {
        parser: "universal",
        caption: "Entrada: Palmeiras +0.25 (1-0)",
        parsed: { selecao: "Palmeiras +0.25" },
      },
    }, opts());

    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: result.betId } }))
      .toMatchObject({
        selecao: "Palmeiras +0.25",
        liveScoreHome: 1,
        liveScoreAway: 0,
      });
  });

  it("não deduplica duas entradas feitas em placares live diferentes", async () => {
    const bankroll = await seedBankroll();
    const common = {
      ...baseInput(bankroll.id),
      mercado: "Asian Handicap",
      selecao: "Palmeiras +0.25",
      source: "web",
      sourceExternalId: undefined,
    };
    const first = await registerBet({
      ...common,
      liveScoreHome: 1,
      liveScoreAway: 0,
    }, opts());
    const second = await registerBet({
      ...common,
      liveScoreHome: 2,
      liveScoreAway: 0,
    }, opts());

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(await db.prisma.bet.count()).toBe(2);
  });

  it("constraint do Postgres recusa placar live pela metade", async () => {
    const bankroll = await seedBankroll();
    const result = await registerBet(baseInput(bankroll.id), opts());

    await expect(db.prisma.$executeRawUnsafe(
      'UPDATE "bets" SET "liveScoreHome" = 1, "liveScoreAway" = NULL WHERE "id" = $1',
      result.betId,
    )).rejects.toThrow(/bets_live_score_pair_check/);
  });

  it("Postgres permite preencher snapshot ausente uma vez e proíbe reescrita", async () => {
    const bankroll = await seedBankroll();
    const result = await registerBet(baseInput(bankroll.id), opts());
    await db.prisma.bet.update({
      where: { id: result.betId },
      data: { liveScoreHome: 1, liveScoreAway: 0 },
    });

    await expect(db.prisma.bet.update({
      where: { id: result.betId },
      data: { liveScoreHome: 2, liveScoreAway: 0 },
    })).rejects.toThrow(/placar live.*imutável/i);
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: result.betId } }))
      .toMatchObject({ liveScoreHome: 1, liveScoreAway: 0 });
  });

  it("persiste captura ambígua como Unknown com evidência temporária", async () => {
    const bankroll = await seedBankroll();
    const result = await registerBet(
      {
        ...baseInput(bankroll.id),
        esporte: "Unknown",
        sportResolutionStatus: "PENDING",
        sportConfidence: 40,
        sportSource: "LLM",
        sportEvidence: [{ source: "LLM", sport: "Basketball", confidence: 40 }],
        captureEvidence: {
          parser: "gemini-vision",
          caption: "Leones Quilpue vs Universidad de Concepcion",
          mediaFileId: "telegram-file-reference",
          parsed: { esporte: "Unknown", mercado: "Moneyline" },
        },
      },
      opts(),
    );
    const bet = await db.prisma.bet.findUniqueOrThrow({
      where: { id: result.betId },
      include: { captureEvidence: true },
    });
    expect(bet).toMatchObject({
      esporte: "Unknown",
      sportResolutionStatus: "PENDING",
      sportConfidence: 40,
      sportSource: "LLM",
      captureEvidence: {
        parser: "gemini-vision",
        mediaFileId: "telegram-file-reference",
      },
    });
    expect(bet.captureEvidence?.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + 29 * 86_400_000,
    );
  });

  it("mesma origem externa (re-entrega do Telegram) é idempotente", async () => {
    const bankroll = await seedBankroll();
    const first = await registerBet(baseInput(bankroll.id), opts());
    const second = await registerBet(baseInput(bankroll.id), opts());

    expect(second.created).toBe(false);
    expect(second.duplicateOfId).toBe(first.betId);
    expect(await db.prisma.bet.count()).toBe(1);
  });

  it("mesma origem externa concorrente cria uma única aposta e uma auditoria", async () => {
    const bankroll = await seedBankroll();
    const input = baseInput(bankroll.id);

    const results = await Promise.all([
      registerBet(input, opts()),
      registerBet(input, opts()),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.betId)).size).toBe(1);
    expect(await db.prisma.bet.count()).toBe(1);
    expect(await db.prisma.auditEvent.count({
      where: { action: "bet.create", resource: "bet" },
    })).toBe(1);
  });

  it("a mensagem sozinha e um item de lote do mesmo post não viram duas apostas", async () => {
    const bankroll = await seedBankroll();
    const avulsa = baseInput(bankroll.id);
    const item = { ...avulsa, sourceExternalId: "555:1", selecao: "Fora", odds: 3.4 };

    const first = await registerBet(item, opts());
    const whole = await registerBet(avulsa, opts());
    expect(whole).toMatchObject({ created: false, duplicateOfId: first.betId });

    await db.prisma.bet.deleteMany();
    const single = await registerBet(avulsa, opts());
    const laterItem = await registerBet(item, opts());
    expect(laterItem).toMatchObject({ created: false, duplicateOfId: single.betId });
    // Os irmãos do mesmo lote continuam livres entre si.
    await db.prisma.bet.deleteMany();
    await registerBet(item, opts());
    expect(await registerBet({ ...item, sourceExternalId: "555:2", selecao: "Empate" }, opts())).toMatchObject({ created: true });
    // A mensagem 5550 não é item da 555.
    expect(await registerBet({ ...avulsa, sourceExternalId: "5550", selecao: "Empate", odds: 3.1 }, opts())).toMatchObject({ created: true });
  });

  it("mensagem sozinha e item de lote concorrentes do mesmo post gravam uma aposta só", async () => {
    const bankroll = await seedBankroll();
    const avulsa = baseInput(bankroll.id);
    const results = await Promise.all([
      registerBet(avulsa, opts()),
      registerBet({ ...avulsa, sourceExternalId: "555:1", selecao: "Fora", odds: 3.4 }, opts()),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await db.prisma.bet.count()).toBe(1);
  });

  it("aposta removida (👎) NÃO é recriada pela mesma origem — e o caller fica sabendo", async () => {
    const bankroll = await seedBankroll();
    const first = await registerBet(baseInput(bankroll.id), opts());
    await db.prisma.bet.update({
      where: { id: first.betId },
      data: { deletedAt: new Date() },
    });

    const again = await registerBet(baseInput(bankroll.id), opts());
    expect(again.created).toBe(false);
    expect(again.duplicateWasDeleted).toBe(true);
    expect(await db.prisma.bet.count()).toBe(1);
  });

  it("conteúdo idêntico sem origem externa é deduplicado (double-submit)", async () => {
    const bankroll = await seedBankroll();
    const input = {
      ...baseInput(bankroll.id),
      source: "web",
      sourceExternalId: undefined,
    };
    const first = await registerBet(input, opts());
    const second = await registerBet(input, opts());

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.duplicateOfId).toBe(first.betId);
    expect(second.duplicateWasDeleted).toBeUndefined();
  });

  it("conteúdo igual em casas diferentes não é engolido pela dedupe L2", async () => {
    const bankroll = await seedBankroll();
    const common = {
      ...baseInput(bankroll.id),
      source: "web",
      sourceExternalId: undefined,
    };
    const betano = await registerBet(common, opts());
    const pinnacle = await registerBet({ ...common, casaDeAposta: "Pinnacle" }, opts());

    expect(betano.created).toBe(true);
    expect(pinnacle.created).toBe(true);
    expect(pinnacle.betId).not.toBe(betano.betId);
    expect(await db.prisma.bet.count()).toBe(2);
  });

  it("deduplica o mesmo conteúdo entre origens com kickoff arredondado em até 60s", async () => {
    const bankroll = await seedBankroll();
    const first = await registerBet({
      ...baseInput(bankroll.id),
      source: "collector-a",
      sourceExternalId: "a",
    }, opts());
    const rounded = await registerBet({
      ...baseInput(bankroll.id),
      data: new Date(KICKOFF.getTime() + 30_000),
      source: "collector-b",
      sourceExternalId: "b",
    }, opts());

    expect(first.created).toBe(true);
    expect(rounded.created).toBe(false);
    expect(rounded.duplicateOfId).toBe(first.betId);
    expect(await db.prisma.bet.count()).toBe(1);
  });

  it("deduplica L2 mesmo quando a outra origem remove diacríticos", async () => {
    const bankroll = await seedBankroll();
    const common = {
      ...baseInput(bankroll.id),
      evento: "São Paulo vs Grêmio",
      selecao: "São Paulo",
      mercado: "Moneyline",
      source: "collector-a",
      sourceExternalId: "accent-a",
    };
    const first = await registerBet(common, opts());
    const second = await registerBet({
      ...common,
      evento: "Sao Paulo vs Gremio",
      selecao: "Sao Paulo",
      source: "collector-b",
      sourceExternalId: "accent-b",
    }, opts());
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.duplicateOfId).toBe(first.betId);
  });

  it("não mistura kickoffs fora da tolerância curta da dedupe L2", async () => {
    const bankroll = await seedBankroll();
    const first = await registerBet({
      ...baseInput(bankroll.id),
      source: "collector-a",
      sourceExternalId: "a",
    }, opts());
    const later = await registerBet({
      ...baseInput(bankroll.id),
      data: new Date(KICKOFF.getTime() + 61_000),
      source: "collector-b",
      sourceExternalId: "b",
    }, opts());

    expect(first.created).toBe(true);
    expect(later.created).toBe(true);
    expect(await db.prisma.bet.count()).toBe(2);
  });

  it("o mesmo post pela DM depois de esporte e horário confirmados é duplicata", async () => {
    const bankroll = await seedBankroll();
    const postedAt = new Date("2026-06-15T14:00:00Z");
    const pending = { ...baseInput(bankroll.id), esporte: "Unknown", data: postedAt, kickoffInferido: true,
      sportResolutionStatus: "PENDING" as const, sportConfidence: 0, sportSource: "UNRESOLVED" as const };
    const channel = await registerBet(pending, opts());
    // O resolvedor confirma pela porta de edição: o mercado passa pelo
    // catálogo do futebol e o horário vira o do jogo.
    const stored = await db.prisma.bet.findUniqueOrThrow({ where: { id: channel.betId } });
    await confirmBetSport({
      bet: stored, candidate: { sport: "Soccer", confidence: 100, source: "TEAM_ID" }, candidates: [], now: postedAt,
      identity: { data: KICKOFF, kickoffInferido: false, competicao: stored.competicao, pais: stored.pais },
    });
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: channel.betId } })).toMatchObject({ esporte: "Soccer", kickoffInferido: false });

    const dm = await registerBet({ ...pending, data: new Date("2026-06-15T15:30:00Z"),
      source: "telegram-dm:42", sourceExternalId: "dm-1" }, opts());

    expect(dm).toMatchObject({ created: false, duplicateOfId: channel.betId });
    expect(await db.prisma.bet.count()).toBe(1);
  });

  it("DM com esporte chega antes de o canal sair do Unknown: também é a mesma aposta", async () => {
    const bankroll = await seedBankroll();
    const channel = await registerBet({ ...baseInput(bankroll.id), esporte: "Unknown", data: new Date("2026-06-15T14:00:00Z"),
      kickoffInferido: true, sportResolutionStatus: "PENDING" as const, sportConfidence: 0, sportSource: "UNRESOLVED" as const }, opts());
    const dm = await registerBet({ ...baseInput(bankroll.id), source: "telegram-dm:42", sourceExternalId: "dm-4" }, opts());
    expect(dm).toMatchObject({ created: false, duplicateOfId: channel.betId });
  });

  describe("múltipla pelo canal com esporte e pela DM sem esporte", () => {
    const channelSide = (bankrollId: string, ticket: { evento: string; selecao: string }) => ({
      ...baseInput(bankrollId), ...ticket, mercado: "Moneyline", sourceExternalId: "600" });
    const dmSide = (bankrollId: string, ticket: { evento: string; selecao: string }) => ({
      ...channelSide(bankrollId, ticket), esporte: "Unknown", sportResolutionStatus: "PENDING" as const, sportConfidence: 0,
      sportSource: "UNRESOLVED" as const, source: "telegram-dm:42", sourceExternalId: "dm-10" });
    const double = { evento: "Verdao vs Santos / Flamengo vs Vasco", selecao: "Verdao / Flamengo" };
    const sameGame = { evento: "Palmeiras vs Santos", selecao: "Palmeiras ML + Over 2.5" };

    it.each([
      ["dupla em ML, canal antes", double, "channel"],
      ["dupla em ML, DM antes", double, "dm"],
      ["ML + Over 2.5 do mesmo jogo, canal antes", sameGame, "channel"],
      ["ML + Over 2.5 do mesmo jogo, DM antes", sameGame, "dm"],
    ] as const)("%s: é a mesma aposta", async (_name, ticket, first) => {
      const bankroll = await seedBankroll();
      const [a, b] = first === "channel"
        ? [channelSide(bankroll.id, ticket), dmSide(bankroll.id, ticket)]
        : [dmSide(bankroll.id, ticket), channelSide(bankroll.id, ticket)];
      const stored = await registerBet(a, opts());
      const repeated = await registerBet(b, opts());
      expect(stored.created).toBe(true);
      expect(repeated).toMatchObject({ created: false, duplicateOfId: stored.betId });
      expect(await db.prisma.bet.count()).toBe(1);
    });

    it("com uma perna diferente continuam duas apostas", async () => {
      const bankroll = await seedBankroll();
      await registerBet(channelSide(bankroll.id, double), opts());
      const other = await registerBet(dmSide(bankroll.id, { ...double, selecao: "Verdao / Vasco" }), opts());
      expect(other.created).toBe(true);
      expect(await db.prisma.bet.count()).toBe(2);
    });
  });

  it("a aposta repetida fica registrada na que a engoliu, com a origem, e aparece na trilha", async () => {
    const bankroll = await seedBankroll();
    const channel = await registerBet(baseInput(bankroll.id), opts());
    await registerBet({ ...baseInput(bankroll.id), source: "telegram-dm:42", sourceExternalId: "dm-5", actor: "telegram-dm" }, opts());

    const evidence = await db.prisma.auditEvent.findFirstOrThrow({ where: { resource: "bet", resourceId: channel.betId, action: "bet.duplicate_absorbed" } });
    expect(evidence).toMatchObject({ actor: "telegram-dm", details: expect.objectContaining({ source: "telegram-dm:42", sourceExternalId: "dm-5" }) });
    const { getTrilhaDaAposta } = await import("@/src/services/painel/aposta/trilha");
    expect((await getTrilhaDaAposta(channel.betId)).linhas.map((linha) => linha.chave)).toContain("captura_repetida");
  });

  it.each(["removida", "editada"])("origem absorvida não recria a aposta %s na reentrega", async (change) => {
    const bankroll = await seedBankroll();
    const input = baseInput(bankroll.id);
    const first = await registerBet(input, opts());
    const repeated = { ...input, source: "telegram-dm:42", sourceExternalId: "dm-5" };
    expect(await registerBet(repeated, opts())).toMatchObject({ created: false, betId: first.betId });
    if (change === "removida") await softDeleteBet({ betId: first.betId, actor: "test", motivo: "teste", origin: "painel" }, { client: db.prisma, deferEffects: true });
    else await db.prisma.bet.update({ where: { id: first.betId }, data: { odds: 3, selecao: "Palmeiras" } });
    expect(await registerBet(repeated, opts())).toMatchObject({ created: false, betId: first.betId,
      duplicateWasDeleted: change === "removida" });
    expect(await db.prisma.bet.count()).toBe(1);
  });

  it("a auditoria de uma origem absorvida anterior ao recibo também impede reprocessar", async () => {
    const bankroll = await seedBankroll();
    const input = baseInput(bankroll.id);
    const original = await registerBet(input, opts());
    const repeated = { ...input, source: "telegram-dm:42", sourceExternalId: "dm-antiga" };
    await db.prisma.auditEvent.create({ data: { action: "bet.duplicate_absorbed", resource: "bet", resourceId: original.betId,
      details: { source: repeated.source, sourceExternalId: repeated.sourceExternalId } } });
    await db.prisma.bet.update({ where: { id: original.betId }, data: { odds: 3 } });
    expect(await registerBet(repeated, opts())).toMatchObject({ created: false, betId: original.betId });
    expect(await findPostSourceUse(repeated.source, repeated.sourceExternalId, db.prisma))
      .toEqual({ kind: "bet", betId: original.betId, deleted: false });
  });

  it("tentativas simultâneas de absorver a mesma origem produzem um recibo e uma decisão", async () => {
    const bankroll = await seedBankroll();
    const input = baseInput(bankroll.id);
    const first = await registerBet(input, opts());
    const repeated = { ...input, source: "telegram-dm:42", sourceExternalId: "dm-5" };
    const results = await Promise.all(Array.from({ length: 4 }, () => registerBet(repeated, opts())));
    expect(results.every((result) => !result.created && result.betId === first.betId)).toBe(true);
    expect(await db.prisma.absorbedBetSource.count()).toBe(1);
    expect(await db.prisma.auditEvent.count({ where: { action: "bet.duplicate_absorbed" } })).toBe(1);
    expect(await db.prisma.bet.count()).toBe(1);
  });

  it("disputa entre absorver e criar na mesma origem tem um único vencedor", async () => {
    const bankroll = await seedBankroll();
    const input = baseInput(bankroll.id);
    await registerBet(input, opts());
    const repeated = { ...input, source: "telegram-dm:42", sourceExternalId: "dm-5" };
    const results = await Promise.all([registerBet(repeated, opts()), registerBet({ ...repeated, odds: 4, selecao: "Empate" }, opts())]);
    expect(new Set(results.map((result) => result.betId)).size).toBe(1);
    const where = { source: repeated.source, sourceExternalId: repeated.sourceExternalId };
    expect(await db.prisma.bet.count({ where }) + await db.prisma.absorbedBetSource.count({ where })).toBe(1);
  });

  it("falha depois da absorção reverte recibo e auditoria, e permite repetir a transação", async () => {
    const bankroll = await seedBankroll();
    const input = baseInput(bankroll.id);
    const first = await registerBet(input, opts());
    const repeated = { ...input, source: "telegram-dm:42", sourceExternalId: "dm-5" };
    await expect(runSerializableTransaction("test.rollback", async (tx) => {
      expect(await registerBet(repeated, { client: reuseSerializableTransaction(tx) })).toMatchObject({ created: false });
      throw new Error("falha depois da absorção");
    }, opts())).rejects.toThrow("falha depois da absorção");
    expect(await db.prisma.absorbedBetSource.count()).toBe(0);
    expect(await db.prisma.auditEvent.count({ where: { action: "bet.duplicate_absorbed" } })).toBe(0);
    expect(await registerBet(repeated, opts())).toMatchObject({ created: false, betId: first.betId });
    expect(await db.prisma.absorbedBetSource.count()).toBe(1);
  });

  it("o recibo impede recaptura mesmo depois de expirar a auditoria da absorção", async () => {
    const bankroll = await seedBankroll();
    const input = baseInput(bankroll.id);
    const first = await registerBet(input, opts());
    const repeated = { ...input, source: "telegram-dm:42", sourceExternalId: "dm-5" };
    await registerBet(repeated, opts());
    await db.prisma.auditEvent.updateMany({ where: { action: "bet.duplicate_absorbed" }, data: { createdAt: new Date(Date.now() - 366 * 86_400_000) } });
    await purgeOldAuditEvents();
    expect(await db.prisma.auditEvent.count({ where: { action: "bet.duplicate_absorbed" } })).toBe(0);
    await db.prisma.bet.update({ where: { id: first.betId }, data: { odds: 3 } });
    expect(await registerBet(repeated, opts())).toMatchObject({ created: false, betId: first.betId });
  });

  it("reentrega de origem absorvida não repete o evento de auditoria", async () => {
    const bankroll = await seedBankroll();
    await registerBet(baseInput(bankroll.id), opts());
    const repeated = { ...baseInput(bankroll.id), source: "telegram-dm:42", sourceExternalId: "dm-5" };
    await registerBet(repeated, opts());
    await registerBet(repeated, opts());
    expect(await db.prisma.auditEvent.count({ where: { action: "bet.duplicate_absorbed" } })).toBe(1);
  });

  it("item absorvido ocupa seu post inteiro, sem confundir prefixos nem bloquear irmãos do lote", async () => {
    const bankroll = await seedBankroll();
    const input = baseInput(bankroll.id);
    const first = await registerBet(input, opts());
    await registerBet({ ...input, sourceExternalId: "556:1" }, opts());
    expect(await findPostSourceUse(input.source, "556", db.prisma)).toEqual({ kind: "bet", betId: first.betId, deleted: false });
    expect(await findPostSourceUse(input.source, "55", db.prisma)).toBeNull();
    expect(await findPostSourceUse(input.source, [], db.prisma)).toBeNull();
    expect(await registerBet({ ...input, sourceExternalId: "556:2", selecao: "Fora", odds: 3.4 }, opts())).toMatchObject({ created: true });
    expect(await registerBet({ ...input, sourceExternalId: "556", selecao: "Empate", odds: 4 }, opts()))
      .toMatchObject({ created: false });
    expect(await db.prisma.bet.count()).toBe(2);
  });

  it("kickoff fora da janela do post ao post + 36 h não é o mesmo post", async () => {
    const bankroll = await seedBankroll();
    const pending = { ...baseInput(bankroll.id), esporte: "Unknown", data: new Date("2026-06-15T14:00:00Z"), kickoffInferido: true,
      sportResolutionStatus: "PENDING" as const, sportConfidence: 0, sportSource: "UNRESOLVED" as const };
    await registerBet(pending, opts());
    // Dois posts sem horário, 40 h separados: não há kickoff que caiba nos dois.
    const later = await registerBet({ ...pending, data: new Date("2026-06-17T06:00:00Z"),
      source: "telegram-dm:42", sourceExternalId: "dm-2" }, opts());
    expect(later.created).toBe(true);
    // A DM chegou depois do jogo que o canal já tinha com horário: outra aposta.
    const played = await registerBet({ ...pending, esporte: "Soccer", data: new Date("2026-06-18T19:00:00Z"), kickoffInferido: false,
      sportResolutionStatus: "CONFIRMED" as const, sportConfidence: 100, sportSource: "TEAM_ID" as const, sourceExternalId: "canal-3" }, opts());
    const dmAfterKickoff = await registerBet({ ...pending, data: new Date("2026-06-18T21:00:00Z"),
      source: "telegram-dm:42", sourceExternalId: "dm-3" }, opts());
    expect(played.created).toBe(true);
    expect(dmAfterKickoff.created).toBe(true);
  });

  it("repost no mesmo canal continua separado, mesmo no mesmo dia", async () => {
    const bankroll = await seedBankroll();
    const pending = { ...baseInput(bankroll.id), esporte: "Unknown", data: new Date("2026-06-15T14:00:00Z"), kickoffInferido: true,
      sportResolutionStatus: "PENDING" as const, sportConfidence: 0, sportSource: "UNRESOLVED" as const };
    const first = await registerBet(pending, opts());
    const repost = await registerBet({ ...pending, data: new Date("2026-06-15T16:00:00Z"), sourceExternalId: "556" }, opts());
    expect(first.created).toBe(true);
    expect(repost.created).toBe(true);
  });

  it("conteúdo de uma exclusão manual pode ser registrado novamente", async () => {
    const bankroll = await seedBankroll();
    const input = {
      ...baseInput(bankroll.id),
      source: "web-manual",
      sourceExternalId: undefined,
    };
    const first = await registerBet(input, opts());
    await db.prisma.bet.update({
      where: { id: first.betId },
      data: { deletedAt: new Date(), status: "CANCELED", settledAt: new Date() },
    });

    const recreated = await registerBet(input, opts());
    expect(recreated.created).toBe(true);
    expect(recreated.betId).not.toBe(first.betId);
    expect(await db.prisma.bet.count()).toBe(2);
  });

  it("normaliza odds/stake à precisão do schema antes de deduplicar", async () => {
    const bankroll = await seedBankroll();
    const input = {
      ...baseInput(bankroll.id),
      source: "web",
      sourceExternalId: undefined,
      odds: 1.987654,
      stake: 0.123456789,
    };
    const first = await registerBet(input, opts());
    const second = await registerBet(input, opts());
    const stored = await db.prisma.bet.findUniqueOrThrow({ where: { id: first.betId } });

    expect(stored.odds.toNumber()).toBe(1.9877);
    expect(stored.stake.toNumber()).toBe(0.123457);
    expect(second.created).toBe(false);
    expect(second.duplicateOfId).toBe(first.betId);
    expect(await db.prisma.bet.count()).toBe(1);
  });

  it("rejeita valores positivos que virariam zero ou odd 1 na precisão do banco", async () => {
    const bankroll = await seedBankroll();
    await expect(
      registerBet({ ...baseInput(bankroll.id), odds: 1.00001 }, opts()),
    ).rejects.toThrow(/normalização/i);
    await expect(
      registerBet({ ...baseInput(bankroll.id), stake: 0.0000001 }, opts()),
    ).rejects.toThrow(/normalização/i);
  });

  it("vincula a conta ATIVA da casa, preferindo a do bankroll sobre a global", async () => {
    const bankroll = await seedBankroll();
    const globalConta = await db.prisma.conta.create({
      data: { casaDeAposta: "Betano", titular: "Global", saldoInicial: 0 },
    });
    const ligada = await db.prisma.conta.create({
      data: {
        casaDeAposta: "betano", // caixa diferente de propósito
        titular: "Do Bankroll",
        saldoInicial: 0,
        bankrollLinks: { create: { bankrollId: bankroll.id } },
      },
    });

    const result = await registerBet(baseInput(bankroll.id), opts());
    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: result.betId } });
    expect(bet.contaId).toBe(ligada.id);
    expect(bet.contaId).not.toBe(globalConta.id);
  });

  it("vincula contas por marca canônica apesar de sufixo ou espaçamento legado", async () => {
    const bankroll = await seedBankroll();
    const conta = await db.prisma.conta.create({
      data: {
        casaDeAposta: "EsportesDaSorte Online",
        titular: "Conta legada",
        saldoInicial: 0,
      },
    });
    const result = await registerBet({
      ...baseInput(bankroll.id),
      casaDeAposta: "Esportes da Sorte",
    }, opts());
    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: result.betId } });
    expect(bet.casaDeAposta).toBe("Esportes da Sorte");
    expect(bet.contaId).toBe(conta.id);
  });

  it("vincula Bet365 Brasil armazenada à aposta canônica Bet365", async () => {
    const bankroll = await seedBankroll();
    const conta = await db.prisma.conta.create({
      data: { casaDeAposta: "Bet365 Brasil", titular: "Legada", saldoInicial: 0 },
    });
    const result = await registerBet({
      ...baseInput(bankroll.id),
      casaDeAposta: "Bet365",
    }, opts());
    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: result.betId } });
    expect(bet.contaId).toBe(conta.id);
  });

  it("vincula conta com sufixo VIP à marca canônica", async () => {
    const bankroll = await seedBankroll();
    const conta = await db.prisma.conta.create({
      data: { casaDeAposta: "Stake VIP", titular: "VIP", saldoInicial: 0 },
    });
    const result = await registerBet({
      ...baseInput(bankroll.id),
      casaDeAposta: "Stake",
    }, opts());
    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: result.betId } });
    expect(bet.casaDeAposta).toBe("Stake");
    expect(bet.contaId).toBe(conta.id);
  });

  it("bankroll com vincularContas=false não vincula conta", async () => {
    const bankroll = await seedBankroll({ vincularContas: false });
    await db.prisma.conta.create({
      data: { casaDeAposta: "Betano", titular: "Global", saldoInicial: 0 },
    });
    const result = await registerBet(baseInput(bankroll.id), opts());
    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: result.betId } });
    expect(bet.contaId).toBeNull();
  });

  it("mais de uma conta global da mesma casa falha fechada", async () => {
    const bankroll = await seedBankroll();
    await db.prisma.conta.createMany({
      data: [
        { casaDeAposta: "Betano", titular: "Global A", saldoInicial: 0 },
        { casaDeAposta: "betano", titular: "Global B", saldoInicial: 0 },
      ],
    });

    const result = await registerBet(baseInput(bankroll.id), opts());
    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: result.betId } });
    expect(bet.contaId).toBeNull();
  });

  it("mercado desconhecido persiste como veio com mercadoMatched=false", async () => {
    const bankroll = await seedBankroll();
    const result = await registerBet(
      { ...baseInput(bankroll.id), mercado: "Mercado Exótico Inventado" },
      opts(),
    );
    expect(result.mercadoMatched).toBe(false);
    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: result.betId } });
    expect(bet.mercado).toBe("Mercado Exótico Inventado");
  });

  it("tetos de sanidade rejeitam odd/stake/data absurdas (saída de LLM é hostil)", async () => {
    const bankroll = await seedBankroll();
    await expect(
      registerBet({ ...baseInput(bankroll.id), odds: 99999 }, opts()),
    ).rejects.toThrow(/teto de sanidade/);
    await expect(
      registerBet({ ...baseInput(bankroll.id), stake: 5000 }, opts()),
    ).rejects.toThrow(/teto de sanidade/);
    await expect(
      registerBet(
        { ...baseInput(bankroll.id), data: new Date("2031-01-01T00:00:00Z") },
        opts(),
      ),
    ).rejects.toThrow(/janela/);
  });

  it("bankroll removido é rejeitado", async () => {
    const bankroll = await seedBankroll();
    await db.prisma.bankroll.delete({ where: { id: bankroll.id } });
    await expect(registerBet(baseInput(bankroll.id), opts())).rejects.toThrow(
      /inexistente ou removido/,
    );
  });
});

it("grava separadamente postagem e registro e não altera a postagem em uma reentrega", async () => {
  const bankroll = await db.prisma.bankroll.create({ data: { nome: "Will retry", slug: "will-retry" } });
  const input = { bankrollId: bankroll.id, evento: "Altamura vs Bari", esporte: "Soccer", mercado: "Total (Corners) – Match",
    selecao: "Under 8.5", data: new Date("2026-09-11T19:00:00Z"), sourcePostedAt: new Date("2026-09-11T18:57:47Z"),
    odds: 1.825, stake: 0.5, source: "telegram-channel:-1001", sourceExternalId: "508" };
  const first = await registerBet(input, { client: db.prisma });
  const second = await registerBet({ ...input, sourcePostedAt: new Date("2026-09-11T19:15:07Z") }, { client: db.prisma });
  const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: first.betId } });
  expect(second).toMatchObject({ created: false, betId: first.betId });
  expect(bet.sourcePostedAt).toEqual(input.sourcePostedAt);
  expect(bet.registradoEm.getTime()).toBeGreaterThan(input.sourcePostedAt.getTime());
  expect(entrouAoVivo({ ...bet, kickoff: bet.data })).toBe(false);
});


describe("registro não converte termos promocionais em stake em dinheiro", () => {
  it.each(["Aposta grátis", "Reembolsada se perder"])("recusa o mercado explícito %s antes da normalização", async (mercado) => {
    const bankroll = await seedBankroll();
    await expect(registerBet({ ...baseInput(bankroll.id), mercado }, opts())).rejects.toThrow(/promocional/i);
    expect(await db.prisma.bet.count()).toBe(0);
  });
  it("confere a promoção na perna da múltipla", async () => {
    const bankroll = await seedBankroll();
    await expect(registerBet({ ...baseInput(bankroll.id), legsJson: { kind: "parlay", legs: [
      { evento: "Flamengo vs Palmeiras", mercado: "Moneyline", selecao: "Flamengo" },
      { evento: "Spain vs Italy", mercado: "Aposta grátis", selecao: "Spain" },
    ] } }, opts())).rejects.toThrow(/promocional/i);
    expect(await db.prisma.bet.count()).toBe(0);
  });
});


it.each([
  "🎁 Deposite R$50 e ganhe R$50 em apostas grátis: bit.ly/x", "Primeira aposta sem risco na KTO 👉 link", "bet365 - Pagamento Antecipado",
  "Responsabilidade sempre, jogue com moderação +18", "Contra tudo e contra todos 🔥", "LeBron lay-up",
])("registro aceita a aposta com rodapé na legenda: %s", async (footer) => {
  const bankroll = await seedBankroll();
  const result = await registerBet({ ...baseInput(bankroll.id),
    captureEvidence: { parser: "universal", caption: `Flamengo ML @1.90 1u\n${footer}`, parsed: {} } }, opts());
  expect(result.created).toBe(true);
});
it.each([["Tipo: aposta grátis", /promocional/i], ["Lay Flamengo @2.0", /contrato financeiro/i]] as const)("registro recusa a legenda que rotula a aposta: %s", async (label, message) => {
  const bankroll = await seedBankroll();
  await expect(registerBet({ ...baseInput(bankroll.id),
    captureEvidence: { parser: "universal", caption: `Flamengo ML @1.90 1u\n${label}`, parsed: {} } }, opts())).rejects.toThrow(message);
  expect(await db.prisma.bet.count()).toBe(0);
});

it.each(["Lay Flamengo", "Contra Flamengo", "Cash-out parcial: 50%"])("registro recusa operação sem contrato: %s", async (selecao) => {
  const bankroll = await seedBankroll();
  await expect(registerBet({ ...baseInput(bankroll.id), selecao }, opts())).rejects.toThrow(/contrato financeiro/i);
  expect(await db.prisma.bet.count()).toBe(0);
});
it("registro verifica direção financeira nas pernas", async () => {
  const bankroll = await seedBankroll();
  await expect(registerBet({ ...baseInput(bankroll.id), legsJson: { kind: "parlay", legs: [
    { evento: "Flamengo vs Palmeiras", mercado: "Moneyline", selecao: "Flamengo" },
    { evento: "Spain vs Italy", mercado: "Lay", selecao: "Spain" },
  ] } }, opts())).rejects.toThrow(/contrato financeiro/i);
  expect(await db.prisma.bet.count()).toBe(0);
});


it("persiste a prorrogação dita só na seleção sem fabricar referência de 90 minutos", async () => {
  const bankroll = await seedBankroll();
  const result = await registerBet({ ...baseInput(bankroll.id), mercado: "Total", selecao: "Over 2.5 incluindo prorrogação" }, opts());
  const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: result.betId } });
  expect([bet.mercado, bet.selecao].some(marketIncludesExtraTime)).toBe(true);
  expect(providerCoversBet("bridgeodds", bet)).toBe(false);
  expect(providerCoversBet("pinnacle17", bet)).toBe(false);
});
