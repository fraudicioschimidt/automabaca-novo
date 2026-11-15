import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * "Odds fechamento" manual (botão da ficha) — escopa o ciclo de closing a UMA
 * banca reusando runClosingSyncOnce, com a server action sob requireSession.
 * Postgres real; só alerta/headers/cache mockados. Usa o caminho
 * Pinnacle com identidade e entrada pré-jogo, sem cotação armazenada →
 * após kickoff congela sem rede.
 */

const alertSpy = vi.fn(async (_m: string) => true);
vi.mock("@/src/services/ops/alerts", () => ({
  sendOperationalAlert: (m: string) => alertSpy(m),
  sendOperatorNotification: (m: string) => alertSpy(m),
}));

const h = vi.hoisted(() => ({ user: "tester" }));
vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (k: string) => (k === "x-auth-user" ? h.user : null),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { runClosingSyncOnce } = await import("@/src/services/sharp/closing/sync");
const { buscarFechamentoAction } = await import("@/app/(painel)/tipsters/[slug]/actions");

let db: TestDb;
beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.dispose();
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await db.reset();
  alertSpy.mockClear();
  h.user = "tester";
});
afterEach(() => {
  vi.useRealTimers();
});

const NOW = new Date("2026-06-10T22:00:00Z");

async function bancaComAposta(slug: string, ext: string) {
  const bk = await db.prisma.bankroll.create({
    data: { nome: slug, slug, valorUnidade: 100, sharpMode: "CLV_ONLY" },
  });
  await db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      settledAt: null,
      bankrollId: bk.id,
      data: new Date(NOW.getTime() - 60_000), // kickoff passou 1min
      registradoEm: new Date(NOW.getTime() - 60 * 60_000),
      evento: "Time A vs Time B",
      esporte: "Soccer",
      // Mercado fora da cobertura BridgeOdds: esta suíte prova somente o
      // escopo manual por banca e o congelamento do caminho não-Bridge.
      mercado: "Total (Bookings) – Match",
      selecao: "Over 3.5",
      odds: 2,
      stake: 1,
      status: "PENDING",
      source: "test",
      sourceExternalId: ext,
      // Nenhuma cotação pré-jogo armazenada; após kickoff não busca preço ao vivo.
      sharp: { create: { identityStatus: "MATCHED", provider: "pinnacle17", providerMatchId: "123", confidence: 90 } },
    },
  });
  return bk;
}

describe("runClosingSyncOnce escopado por banca", () => {
  it("processa só as apostas da banca pedida; as outras ficam intactas", async () => {
    const a = await bancaComAposta("alpha", "cm-a");
    const b = await bancaComAposta("beta", "cm-b");

    const r = await runClosingSyncOnce({ now: NOW, bankrollId: a.id });
    expect(r.processed).toBe(1); // só a aposta de alpha entrou no lote
    expect(r.closed).toBe(1); // congelou (perdeu janela → clvReliable false)

    // alpha: congelado; beta: intocado (não foi selecionado).
    const cA = await db.prisma.betClosing.findFirst({ where: { bet: { bankrollId: a.id } } });
    expect(cA?.fetchedAt).not.toBeNull();
    expect(cA?.clvReliable).toBe(false);
    expect(await db.prisma.betClosing.count({ where: { bet: { bankrollId: b.id } } })).toBe(0);
  });
});

describe("buscarFechamentoAction (server action)", () => {
  it("admin dispara o ciclo da banca e recebe o resumo", async () => {
    const a = await bancaComAposta("alpha", "cm-a2");
    expect(await buscarFechamentoAction("alpha")).toMatchObject({ ok: true, processed: 1, closed: 1 });
    const c = await db.prisma.betClosing.findFirst({ where: { bet: { bankrollId: a.id } } });
    expect(c?.fetchedAt).not.toBeNull();
  });

  it("sem sessão é BARRADO (não dispara nada)", async () => {
    await bancaComAposta("alpha", "cm-a3");
    h.user = "";
    await expect(buscarFechamentoAction("alpha")).rejects.toThrow(/Sessão inválida/);
    expect(await db.prisma.betClosing.count()).toBe(0); // nada foi processado
  });

  it("banca inexistente volta como recusa com a mensagem, sem efeito", async () => {
    await expect(buscarFechamentoAction("nao-existe")).resolves.toEqual({ ok: false, erro: 'Tipster "nao-existe" não encontrado.' });
  });
});
