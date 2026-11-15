import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ParsedBetPost } from "@/src/domain/bet-capture";
import { CapturePolicy } from "@/src/generated/prisma/enums";
import { prepareBetForCapture } from "@/src/services/capture/preparation/prepare-capture";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedTeamCard } from "../helpers/team-cards";

/**
 * A aposta lida, pronta para o registro, contra Postgres real: os nomes que a
 * captura grava e o esporte que ela decide, nos casos que aconteceram em
 * produção com os nomes que a base de times conhece.
 */
let db: TestDb;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); });

/** Ficha de clube de futebol com o nome da Pinnacle em 2 jogos e, se houver, um nome de tipster confirmado. */
async function seedLearnedClub(pinnacleName: string, tipsterName: string | null, pais: string) {
  await seedTeamCard(db.prisma, {
    flashscoreTeamId: `fs-${pinnacleName}`, flashscoreName: pinnacleName, country: pais,
    pinnacleNames: [{ name: pinnacleName }],
    tipsterNames: tipsterName ? [{ name: tipsterName }] : [],
  });
}

const read: Omit<ParsedBetPost, "evento" | "mercado" | "selecao" | "odds"> = {
  esporte: "Unknown", competicao: "", pais: "", stake: 1, data: new Date("2026-06-15T22:00:00Z"), casaDeAposta: "",
};

describe("casos reais da ficha do time", () => {
  const post = ["Botafogo 77x97 Flamengo", "Flamengo +8.5 @1.85", "Flamengo ML @1.30", "1u"].join("\n");
  /** As duas apostas do post, cada uma com os números do seu item. */
  const items: Array<[string, ParsedBetPost, string]> = [
    ["Flamengo +8.5", { ...read, evento: "Botafogo vs Flamengo", mercado: "Handicap", selecao: "Flamengo +8.5", odds: 1.85 }, "Flamengo +8.5 @1.85 1u"],
    ["Flamengo ML", { ...read, evento: "Botafogo vs Flamengo", mercado: "Moneyline", selecao: "Flamengo", odds: 1.3 }, "Flamengo ML @1.30 1u"],
  ];
  const prepare = (bet: ParsedBetPost, caption: string, channelSports: string[] = []) =>
    prepareBetForCapture({ bet, caption, postCaption: post, capturePolicy: CapturePolicy.AUTO, channelSports });

  it.each(items)("basquete \"Botafogo 77x97 Flamengo\", %s: grava os nomes do post e não confirma futebol", async (_label, bet, caption) => {
    await seedLearnedClub("Botafogo FR RJ", "Botafogo", "Brazil");
    await seedLearnedClub("Flamengo", null, "Brazil");

    expect(await prepare(bet, caption)).toMatchObject({
      ok: true, bet: { evento: "Botafogo vs Flamengo", selecao: bet.selecao, esporte: "Unknown", sportResolution: { status: "PENDING" } },
    });

    // O canal que o dono marcou com basquete confirma, com os mesmos nomes.
    expect(await prepare(bet, caption, ["Basketball"])).toMatchObject({
      ok: true, bet: { evento: "Botafogo vs Flamengo", esporte: "Basketball", sportResolution: { status: "CONFIRMED", source: "CHANNEL" } },
    });
  });

  it("Chelsea vs Arsenal com o nome de tipster errado na ficha (Chelsea → Brentford): grava Chelsea, com a seleção", async () => {
    await seedLearnedClub("Brentford", "Chelsea", "England");
    const bet = { ...read, evento: "Chelsea vs Arsenal", mercado: "Handicap Asiático", selecao: "Chelsea -0.5", odds: 1.9 };

    expect(await prepareBetForCapture({
      bet, caption: "⚽ Chelsea x Arsenal\nChelsea -0.5 @1.90\n1u", capturePolicy: CapturePolicy.AUTO,
    })).toMatchObject({
      ok: true, bet: { evento: "Chelsea vs Arsenal", selecao: "Chelsea -0.5", esporte: "Soccer", sportResolution: { status: "CONFIRMED" } },
    });
  });
});

describe("marca de reserva do tipster", () => {
  const bet = (evento: string, selecao: string): ParsedBetPost => ({
    ...read, evento, mercado: "Asian Handicap", selecao, odds: 1.9,
  });

  it("no futebol, \"R\" vira Reserva no evento e na seleção", async () => {
    const result = await prepareBetForCapture({
      bet: bet("San Martin R vs Defensa y Justicia R", "San Martin R +0.5"),
      caption: "San Martin R x Defensa y Justicia R\nSan Martin R +0.5 @1.90\n1u",
      capturePolicy: CapturePolicy.AUTO,
      channelSports: ["Soccer"],
    });
    expect(result).toMatchObject({
      ok: true,
      bet: { evento: "San Martin Reserva vs Defensa y Justicia Reserva", selecao: "San Martin Reserva +0.5", esporte: "Soccer" },
    });
  });

  it("no tênis, a inicial do jogador fica", async () => {
    const result = await prepareBetForCapture({
      bet: { ...bet("Nadal R vs Federer R", "Nadal R"), mercado: "Moneyline" },
      caption: "Nadal R x Federer R\nNadal @1.90\n1u",
      capturePolicy: CapturePolicy.AUTO,
      channelSports: ["Tennis"],
    });
    expect(result).toMatchObject({ ok: true, bet: { evento: "Nadal R vs Federer R", esporte: "Tennis" } });
  });
});

