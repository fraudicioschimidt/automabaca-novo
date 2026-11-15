import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  deleteTelegramDmDraft,
  loadTelegramDmDraft,
  saveTelegramDmDraft,
} from "@/src/services/capture/dm-draft";

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

describe("preview durável da DM", () => {
  it("recarrega exatamente a extração mostrada, inclusive kickoff", async () => {
    const now = new Date("2026-07-22T12:00:00Z");
    const kickoff = new Date("2026-07-23T18:30:00Z");
    await saveTelegramDmDraft({
      chatId: "123",
      messageId: 77,
      bet: {
        evento: "Time A vs Time B",
        esporte: "Soccer",
        competicao: "Liga",
        pais: "Brasil",
        mercado: "Total - Match",
        selecao: "Under 2.5",
        odds: 1.91,
        stake: 0.5,
        data: kickoff,
        kickoffDateOnly: false,
        casaDeAposta: "Bet365",
      },
      caption: "preview original",
      imageFileId: "photo-1",
      postDate: now,
      now,
    });

    await expect(loadTelegramDmDraft({ chatId: "123", messageId: 77, now })).resolves.toEqual({
      bet: {
        evento: "Time A vs Time B",
        esporte: "Soccer",
        competicao: "Liga",
        pais: "Brasil",
        mercado: "Total - Match",
        selecao: "Under 2.5",
        odds: 1.91,
        stake: 0.5,
        data: kickoff,
        kickoffDateOnly: false,
        casaDeAposta: "Bet365",
      },
      caption: "preview original",
      imageFileId: "photo-1",
      postDate: now,
    });
  });

  it("guarda o placar da entrada ao vivo, a prop e as pernas que a prévia mostrou; o esporte vai só pelo nome", async () => {
    const now = new Date("2026-07-22T12:00:00Z");
    const legs = {
      kind: "parlay" as const,
      legs: [
        { evento: "Time A vs Time B", mercado: "Moneyline", selecao: "Time A" },
        { evento: "Time C vs Time D", mercado: "Moneyline", selecao: "Time D" },
      ],
    };
    const read = {
      evento: "Time A vs Time B", esporte: "Soccer", competicao: "", pais: "", mercado: "Asian Handicap", selecao: "Time A -0.5",
      odds: 1.9, stake: 1, data: null, casaDeAposta: "", liveScoreHome: 1, liveScoreAway: 0, liveScoreEvidence: "AO VIVO 1-0",
      playerProp: { jogador: "Pedro", mercadoOriginal: "Chutes", selecaoOriginal: "Pedro 2+", substituicao: "UNKNOWN" as const, evidencia: "" },
      legs,
      sportResolution: { sport: "Soccer" as const, status: "CONFIRMED" as const, confidence: 95, source: "EMOJI" as const, evidence: [], resolverVersion: 1 },
    };
    await saveTelegramDmDraft({ chatId: "123", messageId: 80, bet: read, caption: "1u", postDate: now, now });
    const loaded = await loadTelegramDmDraft({ chatId: "123", messageId: 80, now });
    const { sportResolution: _sport, ...shown } = read;
    expect(loaded?.bet).toEqual(shown);
  });

  it("não entrega rascunho expirado", async () => {
    const now = new Date("2026-07-22T12:00:00Z");
    await saveTelegramDmDraft({
      chatId: "123",
      messageId: 78,
      bet: {
        evento: "A vs B",
        esporte: "Soccer",
        competicao: "",
        pais: "",
        mercado: "Moneyline",
        selecao: "A",
        odds: 2,
        stake: 1,
        data: null,
        casaDeAposta: "",
      },
      caption: "",
      postDate: now,
      now,
    });

    const afterExpiry = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    await expect(
      loadTelegramDmDraft({ chatId: "123", messageId: 78, now: afterExpiry }),
    ).resolves.toBeNull();
  });

  it("reentrega da mesma unidade atualiza uma única prévia", async () => {
    const now = new Date("2026-07-22T12:00:00Z");
    const input = {
      chatId: "123",
      messageId: 88,
      bet: {
        evento: "A vs B",
        esporte: "Soccer",
        competicao: "",
        pais: "",
        mercado: "Moneyline",
        selecao: "A",
        odds: 2,
        stake: 1,
        data: null,
        casaDeAposta: "",
      },
      caption: "retry",
      postDate: now,
      now,
    };
    await saveTelegramDmDraft(input);
    await saveTelegramDmDraft(input);
    await expect(db.prisma.telegramDmDraft.count({
      where: { chatId: "123", messageId: 88 },
    })).resolves.toBe(1);
  });

  it("remove o rascunho de forma idempotente ao cancelar", async () => {
    const now = new Date("2026-07-22T12:00:00Z");
    await saveTelegramDmDraft({
      chatId: "123",
      messageId: 79,
      bet: {
        evento: "A vs B",
        esporte: "Soccer",
        competicao: "",
        pais: "",
        mercado: "Moneyline",
        selecao: "A",
        odds: 2,
        stake: 1,
        data: null,
        casaDeAposta: "",
      },
      caption: "",
      postDate: now,
      now,
    });

    await expect(deleteTelegramDmDraft({ chatId: "123", messageId: 79 })).resolves.toBe(true);
    await expect(deleteTelegramDmDraft({ chatId: "123", messageId: 79 })).resolves.toBe(false);
    await expect(loadTelegramDmDraft({ chatId: "123", messageId: 79, now })).resolves.toBeNull();
  });
});
