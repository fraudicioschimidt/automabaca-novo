import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getFrescorDosDados } from "@/src/services/painel/frescor";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); });

const AGORA = new Date("2026-08-12T12:00:00Z");
const minutosAntes = (min: number) => new Date(AGORA.getTime() - min * 60_000);

describe("getFrescorDosDados", () => {
  it("sem dado nenhum, diz que ainda não houve captura nem fechamento", async () => {
    const bank = await db.prisma.bankroll.create({ data: { nome: "Vazia", slug: "vazia" } });
    const { captura, fechamento } = await getFrescorDosDados(bank.id, AGORA);
    expect(captura).toMatchObject({ chave: "captura", idadeMin: null, emISO: null, atrasada: false });
    expect(fechamento).toMatchObject({ chave: "fechamento", idadeMin: null, emISO: null, atrasada: false });
    expect(captura.texto).toBe("nenhuma aposta ainda");
    expect(fechamento.texto).toBe("nenhum fechamento ainda");
  });

  it("mede a última aposta não excluída e o último fechamento, sem alarmar", async () => {
    const bank = await db.prisma.bankroll.create({ data: { nome: "Banca", slug: "banca" } });
    const fixture = {
      bankrollId: bank.id, data: AGORA, evento: "A vs B", esporte: "Soccer",
      mercado: "Moneyline", selecao: "A", odds: 2, stake: 1, sportResolvedAt: AGORA,
    };
    const antiga = await db.prisma.bet.create({ data: { ...fixture, registradoEm: minutosAntes(90) } });
    await db.prisma.bet.create({ data: { ...fixture, registradoEm: minutosAntes(5), deletedAt: AGORA } });
    await db.prisma.betClosing.create({ data: { betId: antiga.id, fetchedAt: minutosAntes(30) } });

    const { captura, fechamento } = await getFrescorDosDados(bank.id, AGORA);
    expect(captura).toMatchObject({ idadeMin: 90, emISO: minutosAntes(90).toISOString(), atrasada: false });
    expect(fechamento).toMatchObject({ idadeMin: 30, emISO: minutosAntes(30).toISOString(), atrasada: false });
  });

  it("mede só a banca do Analyzer: a captura de outra banca não a faz parecer em dia", async () => {
    const parada = await db.prisma.bankroll.create({ data: { nome: "Parada", slug: "parada" } });
    const ativa = await db.prisma.bankroll.create({ data: { nome: "Ativa", slug: "ativa" } });
    const fixture = {
      data: AGORA, evento: "A vs B", esporte: "Soccer",
      mercado: "Moneyline", selecao: "A", odds: 2, stake: 1, sportResolvedAt: AGORA,
    };
    const velha = await db.prisma.bet.create({ data: { ...fixture, bankrollId: parada.id, registradoEm: minutosAntes(3 * 24 * 60) } });
    await db.prisma.betClosing.create({ data: { betId: velha.id, fetchedAt: minutosAntes(2 * 24 * 60) } });
    const excluida = await db.prisma.bet.create({ data: { ...fixture, bankrollId: parada.id, registradoEm: minutosAntes(4 * 24 * 60), deletedAt: AGORA } });
    await db.prisma.betClosing.create({ data: { betId: excluida.id, fetchedAt: minutosAntes(10) } });
    const nova = await db.prisma.bet.create({ data: { ...fixture, bankrollId: ativa.id, registradoEm: minutosAntes(2) } });
    await db.prisma.betClosing.create({ data: { betId: nova.id, fetchedAt: minutosAntes(5) } });

    const { captura, fechamento } = await getFrescorDosDados(parada.id, AGORA);
    expect(captura).toMatchObject({ emISO: minutosAntes(3 * 24 * 60).toISOString() });
    expect(fechamento).toMatchObject({ emISO: minutosAntes(2 * 24 * 60).toISOString() });

    // Na carteira vale a banca mais recente; a aposta excluída continua fora.
    const carteira = await getFrescorDosDados(null, AGORA);
    expect(carteira.captura).toMatchObject({ emISO: minutosAntes(2).toISOString() });
    expect(carteira.fechamento).toMatchObject({ emISO: minutosAntes(5).toISOString() });
  });
});
