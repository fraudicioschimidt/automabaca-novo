import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getSemOddsPorMotivo } from "@/src/services/painel/operacoes/cobertura";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); });

async function aposta(
  bankrollId: string,
  opts: { pais: string; competicao: string; data?: Date; semIdentidade?: string; semAbertura?: string; semFechamento?: string; deletedAt?: Date },
) {
  const bet = await db.prisma.bet.create({
    data: {
      bankrollId,
      data: opts.data ?? new Date("2026-08-02T19:00:00Z"),
      evento: "A vs B",
      esporte: "Soccer",
      pais: opts.pais,
      competicao: opts.competicao,
      mercado: "Moneyline",
      selecao: "A",
      odds: 2,
      stake: 1,
      sportResolvedAt: new Date(),
      deletedAt: opts.deletedAt ?? null,
    },
  });
  if (opts.semIdentidade) {
    await db.prisma.betSharp.create({
      data: { betId: bet.id, identityStatus: "MATCHED", noOddsReason: opts.semIdentidade },
    });
  }
  if (opts.semAbertura) {
    await db.prisma.betOpening.create({ data: { betId: bet.id, attempts: 1, noOpeningReason: opts.semAbertura } });
  }
  if (opts.semFechamento) {
    await db.prisma.betClosing.create({ data: { betId: bet.id, noOddsReason: opts.semFechamento } });
  }
}

/** As fixtures jogam em 02/08; o corte fica um mês antes. */
const DESDE = new Date("2026-07-03T19:00:00Z");

describe("getSemOddsPorMotivo", () => {
  it("agrupa por lado e motivo, com o segmento mais pesado de cada motivo", async () => {
    const bank = await db.prisma.bankroll.create({ data: { nome: "Banca", slug: "banca" } });
    await aposta(bank.id, { pais: "Brasil", competicao: "Série A", semIdentidade: "sem_linha_atual" });
    await aposta(bank.id, { pais: "Brasil", competicao: "Série A", semIdentidade: "sem_linha_atual" });
    await aposta(bank.id, { pais: "Chile", competicao: "", semIdentidade: "sem_linha_atual", semFechamento: "aposta_ao_vivo" });
    await aposta(bank.id, { pais: "Brasil", competicao: "Série A", semFechamento: "aposta_ao_vivo", deletedAt: new Date() });

    const linhas = await getSemOddsPorMotivo(DESDE);

    expect(linhas).toEqual([
      { lado: "identidade", reason: "sem_linha_atual", n: 3, segmentos: 2, topoSegmento: "Brasil · Série A", topoN: 2 },
      { lado: "fechamento", reason: "aposta_ao_vivo", n: 1, segmentos: 1, topoSegmento: "Chile", topoN: 1 },
    ]);
  });

  it("conta só os jogos da janela: motivo de jogo antigo, já consertado, não fica no cartão", async () => {
    const bank = await db.prisma.bankroll.create({ data: { nome: "Banca", slug: "banca" } });
    const antes = new Date(DESDE.getTime() - 60_000);
    await aposta(bank.id, { pais: "Brasil", competicao: "Série A", semIdentidade: "sem_linha_atual" });
    await aposta(bank.id, { pais: "Brasil", competicao: "Série A", data: DESDE, semIdentidade: "sem_linha_atual", semFechamento: "kickoff_sem_captura" });
    await aposta(bank.id, { pais: "Chile", competicao: "", data: antes,
      semIdentidade: "sem_linha_atual", semAbertura: "partida_nao_localizada", semFechamento: "kickoff_sem_captura" });

    const linhas = await getSemOddsPorMotivo(DESDE);

    expect(linhas).toEqual([
      { lado: "identidade", reason: "sem_linha_atual", n: 2, segmentos: 1, topoSegmento: "Brasil · Série A", topoN: 2 },
      { lado: "fechamento", reason: "kickoff_sem_captura", n: 1, segmentos: 1, topoSegmento: "Brasil · Série A", topoN: 1 },
    ]);
  });

  it("a abertura que falta entra como lado próprio", async () => {
    const bank = await db.prisma.bankroll.create({ data: { nome: "Banca", slug: "banca" } });
    await aposta(bank.id, { pais: "Brasil", competicao: "Série A", semAbertura: "partida_nao_localizada" });
    await aposta(bank.id, { pais: "Brasil", competicao: "Série A", semAbertura: "partida_nao_localizada", semFechamento: "kickoff_sem_captura" });
    await aposta(bank.id, { pais: "Chile", competicao: "", semAbertura: "falha_na_consulta", deletedAt: new Date() });

    const linhas = await getSemOddsPorMotivo(DESDE);

    expect(linhas).toEqual([
      { lado: "abertura", reason: "partida_nao_localizada", n: 2, segmentos: 1, topoSegmento: "Brasil · Série A", topoN: 2 },
      { lado: "fechamento", reason: "kickoff_sem_captura", n: 1, segmentos: 1, topoSegmento: "Brasil · Série A", topoN: 1 },
    ]);
  });
});
