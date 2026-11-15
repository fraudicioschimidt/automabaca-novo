import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  clearBridgeSnapshotInflight,
  readBridgeMatchSnapshot,
  withBridgeSnapshotSingleflight,
  writeBridgeMatchSnapshot,
} from "@/src/providers/bridgeodds/snapshot-cache";
import type { BridgeMatch } from "@/src/providers/bridgeodds/types";
import { writeProviderCache } from "@/src/providers/provider-cache";

let db: TestDb;

beforeAll(() => {
  db = createTestDb();
});

afterAll(async () => {
  await db.dispose();
});

beforeEach(async () => {
  await db.reset();
  clearBridgeSnapshotInflight();
});

const MATCH: BridgeMatch = {
  match_id: 9001,
  sport: "Futebol",
  league: "Brazil - Serie A",
  home: "Palmeiras",
  away: "Santos",
  match_date: "2026-08-24T20:00:00.000Z",
  home_score: null,
  away_score: null,
  moneyline: { closing: { home: 1.8, draw: 3.4, away: 4.7 } },
};

describe("snapshot compartilhado BridgeOdds", () => {
  it("separa preço atual de fechamento final e preserva a observação", async () => {
    const currentAt = new Date("2026-08-24T19:00:00.000Z");
    await writeBridgeMatchSnapshot({
      match: MATCH,
      purpose: "current_price",
      observedAt: currentAt,
    });

    await expect(readBridgeMatchSnapshot({
      providerMatchId: "9001",
      purpose: "current_price",
      now: new Date("2026-08-24T19:00:30.000Z"),
    })).resolves.toMatchObject({ match: { match_id: 9001 }, observedAt: currentAt });
    await expect(readBridgeMatchSnapshot({
      providerMatchId: "9001",
      purpose: "closing",
      now: new Date("2026-08-24T19:00:30.000Z"),
    })).resolves.toBeNull();

    const closingAt = new Date("2026-08-24T20:00:05.000Z");
    await writeBridgeMatchSnapshot({
      match: { ...MATCH, moneyline: { closing: { home: 1.75, draw: 3.5, away: 5 } } },
      purpose: "closing",
      observedAt: closingAt,
    });
    await expect(readBridgeMatchSnapshot({
      providerMatchId: "9001",
      purpose: "closing",
      now: new Date("2026-08-25T12:00:00.000Z"),
    })).resolves.toMatchObject({
      match: { match_id: 9001, moneyline: { closing: { home: 1.75 } } },
      observedAt: closingAt,
    });
    await expect(readBridgeMatchSnapshot({
      providerMatchId: "9001",
      purpose: "current_price",
      now: new Date("2026-08-25T12:00:00.000Z"),
    })).resolves.toBeNull();
    expect(await db.prisma.providerCache.count({ where: { provider: "bridgeodds" } })).toBe(2);
  });

  it("resposta de jogo que ainda não começou na Bridge nunca é o fechamento final", async () => {
    // Remarcado: pedida como fechamento depois do horário gravado na aposta,
    // mas antes do início que a Bridge dá.
    const early = new Date("2026-08-24T19:30:00.000Z");
    const later = new Date("2026-08-24T21:00:00.000Z");
    await writeBridgeMatchSnapshot({ match: MATCH, purpose: "closing", observedAt: early });
    await expect(readBridgeMatchSnapshot({ providerMatchId: "9001", purpose: "closing", now: later })).resolves.toBeNull();
    // A linha "final" gravada antes da guarda também não vale.
    await writeProviderCache({ provider: "bridgeodds", key: "match:v2:9001:final",
      data: { version: 1, phase: "final", match: MATCH }, ttlMs: 30 * 86_400_000, now: early });
    await expect(readBridgeMatchSnapshot({ providerMatchId: "9001", purpose: "closing", now: later })).resolves.toBeNull();
  });

  it("linha final colhida antes do horário da aposta não fecha o jogo adiado", async () => {
    // A Bridge ficou com 20:00; a Pinnacle17 deu 23:00 à aposta. Outra aposta
    // do mesmo jogo, ainda com o horário velho, gravou a linha "final" às 20:30.
    const stale = new Date("2026-08-24T20:30:00.000Z");
    await writeBridgeMatchSnapshot({ match: MATCH, purpose: "closing", observedAt: stale });
    const now = new Date("2026-08-24T23:05:00.000Z");

    await expect(readBridgeMatchSnapshot({
      providerMatchId: "9001", purpose: "closing", now, betKickoffUtc: new Date("2026-08-24T23:00:00.000Z"),
    })).resolves.toBeNull();
    // Para a aposta que tem 20:00, a mesma linha continua valendo.
    await expect(readBridgeMatchSnapshot({
      providerMatchId: "9001", purpose: "closing", now, betKickoffUtc: new Date("2026-08-24T20:00:00.000Z"),
    })).resolves.toMatchObject({ observedAt: stale });
  });

  it("mantém identidade por mais tempo sem apresentar preço atual vencido", async () => {
    const observedAt = new Date("2026-08-24T12:00:00.000Z");
    await writeBridgeMatchSnapshot({ match: MATCH, purpose: "identity", observedAt });
    const later = new Date("2026-08-24T12:02:00.000Z");

    await expect(readBridgeMatchSnapshot({
      providerMatchId: "9001", purpose: "current_price", now: later,
    })).resolves.toBeNull();
    await expect(readBridgeMatchSnapshot({
      providerMatchId: "9001", purpose: "identity", now: later,
    })).resolves.toMatchObject({ match: { match_id: 9001 }, observedAt });
  });

  it("o voo em andamento só é dividido por buscas do mesmo alcance", async () => {
    let finishPartial = (_value: null) => {};
    const partial = withBridgeSnapshotSingleflight("9001", "closing", "full:partial",
      () => new Promise<null>((resolve) => { finishPartial = resolve; }));
    // Mesmo alcance: pega carona e não consulta de novo.
    const rider = withBridgeSnapshotSingleflight("9001", "closing", "full:partial",
      async () => { throw new Error("não devia consultar"); });
    // Quem exige resposta completa faz a própria busca em vez de herdar o null.
    const observedAt = new Date("2026-08-24T20:05:00.000Z");
    await expect(withBridgeSnapshotSingleflight("9001", "closing", "full:complete",
      async () => ({ match: MATCH, observedAt }))).resolves.toEqual({ match: MATCH, observedAt });

    finishPartial(null);
    await expect(Promise.all([partial, rider])).resolves.toEqual([null, null]);
  });
});
