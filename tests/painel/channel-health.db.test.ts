import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IdentityStatus, SharpMode } from "@/src/generated/prisma/enums";
import { telegramChannelSource } from "@/src/domain/telegram-source";
import { getCanaisMonitorados } from "@/src/services/painel/operacoes/channels";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); });

const now = new Date("2026-09-24T12:00:00Z");

async function canal(channelId: bigint, sharpMode: SharpMode) {
  return db.prisma.bankroll.create({
    data: { nome: `Canal ${channelId}`, slug: `canal-${-channelId}`, telegramChannelId: channelId, sharpMode },
  });
}

async function aposta(bankrollId: string, channelId: bigint, sharp: { identityStatus: IdentityStatus; noOddsReason?: string } | null) {
  const bet = await db.prisma.bet.create({ data: {
    bankrollId, source: telegramChannelSource(String(channelId)), evento: "A vs B", esporte: "Soccer",
    sportResolutionStatus: "CONFIRMED", sportResolvedAt: now, mercado: "Moneyline", selecao: "A",
    odds: 2, stake: 1, data: now,
  } });
  if (sharp) await db.prisma.betSharp.create({ data: { betId: bet.id, ...sharp } });
}

describe("saúde de identidade do canal (Postgres real)", () => {
  it("múltipla não é falha de identidade; mercado sem cobertura continua sendo", async () => {
    const banca = await canal(-1001n, "CLV_ONLY");
    for (let i = 0; i < 8; i += 1) await aposta(banca.id, -1001n, { identityStatus: "MATCHED" });
    for (let i = 0; i < 2; i += 1) await aposta(banca.id, -1001n, { identityStatus: "UNSUPPORTED", noOddsReason: "multipla" });
    await aposta(banca.id, -1001n, { identityStatus: "UNSUPPORTED", noOddsReason: "unsupported_market" });

    const [saude] = (await getCanaisMonitorados(now)).canais;
    expect(saude!.identity).toMatchObject({ resolved: 8, pending: 0, failed: 1 });
    expect(saude!.identity.taxaOk).toBeCloseTo((8 / 9) * 100, 6);
  });

  it("banca sem identidade (OFF) não mostra a captura como identidade pendente", async () => {
    const banca = await canal(-1002n, "OFF");
    for (let i = 0; i < 3; i += 1) await aposta(banca.id, -1002n, null);

    const [saude] = (await getCanaisMonitorados(now)).canais;
    expect(saude!.capturas).toBe(3);
    expect(saude!.identity).toMatchObject({ resolved: 0, pending: 0, failed: 0, taxaOk: null });
  });
});
