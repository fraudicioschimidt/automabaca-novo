import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// O cadastro manual enfileira a busca de preço depois de gravar; aqui a fila não importa.
vi.mock("@/src/infra/boss", () => ({ getSharedBoss: async () => ({}) }));
vi.mock("@/src/services/scheduling/enqueue-enrich", () => ({ enqueueSharpEnrich: async () => undefined, cancelPendingSharpEnrich: async () => undefined }));

import { canonicalizeBetForRegistration } from "@/src/services/bets/canonicalize-registration";
import { normalizeBetEditInput } from "@/src/services/bets/edit";
import { registerManualBet } from "@/src/services/bets/manual";
import { registerBet } from "@/src/services/bets/register";
import { createTestDb, type TestDb } from "../helpers/db";

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

describe("paridade do contrato de registro entre fontes", () => {
  it.each(["talca dc", "DC talca", "talca (Dupla Chance)"])("grava e edita abreviação de Dupla Chance: %s", async selecao => {
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Target DC", slug: "target-dc", valorUnidade: 100 } });
    const raw = { evento: "Puerto Montt vs Rangers de Talca", esporte: "Soccer", pais: "Chile", competicao: "Primera B",
      mercado: "Moneyline", selecao, odds: 1.8, stake: 0.666667, data: new Date("2026-09-08T21:00:00Z") };
    const { betId } = await registerManualBet(bankroll.id, {
      home: "Puerto Montt", away: "Rangers de Talca", date: "2026-09-08", time: "18:00", esporte: "Soccer", region: "Chile",
      competition: "Primera B", market: "Moneyline", line: selecao, odds: 1.8, stake: 0.666667,
    }, "test-dc");
    const stored = await db.prisma.bet.findUniqueOrThrow({ where: { id: betId } });
    const edited = await normalizeBetEditInput(raw, db.prisma);
    expect(stored).toMatchObject({ mercado: "Double Chance", selecao: "Draw or Rangers de Talca" });
    expect(edited.fields).toMatchObject({ mercado: stored.mercado, selecao: stored.selecao });
    expect(Number(stored.odds)).toBe(1.8);
    expect(Number(stored.stake)).toBe(0.666667);
  });

  it("cadastro manual sem hora grava o dia com o horário a confirmar", async () => {
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Sem hora", slug: "sem-hora", valorUnidade: 100 } });
    const { betId } = await registerManualBet(bankroll.id, {
      home: "Santos", away: "Grêmio", date: "2026-09-24", time: "", market: "Total", line: "Over 2.5", odds: 1.9, stake: 1,
    }, "test-sem-hora");
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: betId }, select: { data: true, kickoffInferido: true } }))
      .toEqual({ data: new Date("2026-09-24T03:00:00Z"), kickoffInferido: true });
  });

  it("persiste web, canal e DM com a mesma canonicalização independente da origem", async () => {
    const bankrolls = await Promise.all(
      ["web", "canal", "dm"].map((source) =>
        db.prisma.bankroll.create({
          data: {
            nome: `Banca ${source}`,
            slug: `banca-${source}`,
            valorUnidade: 100,
          },
        }),
      ),
    );
    const rawBet = {
      evento: "Brasil vs Alemanha",
      esporte: "Soccer",
      pais: "Internacional",
      competicao: "Amistosos Internacionais",
      mercado: "Draw No Bet",
      selecao: "Brasil DNB",
    };
    // O registro não canoniza: o painel canoniza antes de registrar, e a
    // captura, na preparação.
    const web = await registerManualBet(bankrolls[0]!.id, {
      home: "Brasil", away: "Alemanha", date: "2026-08-23", time: "16:00", esporte: "Soccer", region: "Internacional",
      competition: "Amistosos Internacionais", market: "Draw No Bet", line: "Brasil DNB", odds: 1.9, stake: 1, casa: "Pinnacle",
    }, "teste-paridade");
    const preparedCapture = await canonicalizeBetForRegistration(rawBet);
    const captured = await Promise.all(
      ["telegram-channel:-100123", `telegram-dm:123:${bankrolls[2]!.id}`].map((source, index) =>
        registerBet({
          ...preparedCapture,
          bankrollId: bankrolls[index + 1]!.id,
          data: new Date("2026-08-23T19:00:00Z"),
          casaDeAposta: "Pinnacle",
          odds: 1.9,
          stake: 1,
          source,
          actor: "teste-paridade",
        }, { client: db.prisma }),
      ),
    );
    const registered = [web, ...captured];
    const stored = await Promise.all(
      registered.map(({ betId }) =>
        db.prisma.bet.findUniqueOrThrow({
          where: { id: betId },
          select: {
            evento: true,
            pais: true,
            competicao: true,
            mercado: true,
            selecao: true,
          },
        }),
      ),
    );

    expect(stored).toEqual([stored[0], stored[0], stored[0]]);
    expect(stored[0]).toEqual({
      evento: "Brazil vs Germany",
      pais: "International",
      competicao: "International Friendly Games",
      mercado: "Handicap – Match",
      selecao: "Brazil 0",
    });
  });

  it("edição web aplica o mesmo contrato para país, competição, DNB e seleção nacional", async () => {
    const raw = {
      data: new Date("2026-08-23T19:00:00Z"),
      evento: "Brasil vs Santos",
      esporte: "Soccer",
      pais: "Brasil",
      competicao: "Brasileiro Serie A",
      mercado: "Empate Anula a Aposta",
      selecao: "Brasil DNB",
      odds: 1.9,
      stake: 1,
    };
    const registration = await canonicalizeBetForRegistration(raw);
    const edit = await normalizeBetEditInput(raw, db.prisma);

    expect(edit.fields).toMatchObject({
      evento: registration.evento,
      pais: registration.pais,
      competicao: registration.competicao,
      mercado: registration.mercado,
      selecao: registration.selecao,
    });
    expect(edit.fields).toMatchObject({
      evento: "Brazil vs Santos",
      pais: "Brazil",
      mercado: "Handicap – Match",
      selecao: "Brazil 0",
    });
  });

  it("edição web não deixa vocabulário de Double Chance no contrato cru", async () => {
    const raw = {
      data: new Date("2026-08-23T19:00:00Z"),
      evento: "Brazil vs Germany",
      esporte: "Soccer",
      pais: "Internacional",
      competicao: "Amistosos Internacionais",
      mercado: "Chance Dupla",
      selecao: "Dupla Variante: 1X",
      odds: 1.9,
      stake: 1,
    };
    const registration = await canonicalizeBetForRegistration(raw);
    const edit = await normalizeBetEditInput(raw, db.prisma);
    expect(edit.fields).toMatchObject({
      pais: registration.pais,
      competicao: registration.competicao,
    });
    expect(edit.fields).toMatchObject({
      mercado: "Double Chance",
      selecao: "Brazil or Draw",
    });
  });
});
