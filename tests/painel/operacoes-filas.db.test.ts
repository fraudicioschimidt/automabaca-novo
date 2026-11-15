import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  countCasosAbertos,
  countSharpPendentes,
  getCasosAbertos,
  getMatchingOverlap,
  getSharpPendentes,
} from "@/src/services/painel/operacoes/filas";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * A fila "Precisa de você" conta TRABALHO, não linhas de tabela. Uma aposta que
 * a Pinnacle não casou aparece nas duas listas (caso de treino aberto e
 * `UNMATCHED` em `bet_sharp`); a interseção é medida no servidor porque só lá
 * as duas filas têm o total completo.
 */

let db: TestDb;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); });

async function filas() {
  const [{ semMatchTotal, sobrepostos }, casosAbertos, pendentes] = await Promise.all([
    getMatchingOverlap(),
    countCasosAbertos(),
    countSharpPendentes(),
  ]);
  return { semMatchTotal, sobrepostos, casosAbertos, pendentes };
}

async function apostaSemMatch(opts: { comCaso: boolean; nome: string; jogo?: string }) {
  const bankroll = await db.prisma.bankroll.upsert({
    where: { slug: "banca" },
    update: {},
    create: { nome: "Banca", slug: "banca", valorUnidade: 50 },
  });
  const bet = await db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      settledAt: null,
      bankrollId: bankroll.id,
      data: new Date(opts.jogo ?? "2026-08-02T19:00:00Z"),
      evento: opts.nome,
      esporte: "Soccer",
      mercado: "Moneyline",
      selecao: "Casa",
      odds: 1.8,
      stake: 1,
      status: "PENDING",
    },
  });
  await db.prisma.betSharp.create({ data: { betId: bet.id, identityStatus: "UNMATCHED" } });
  if (opts.comCaso) {
    await db.prisma.trainingCase.create({
      data: {
        betId: bet.id,
        status: "OPEN",
        evento: opts.nome,
        esporte: "Soccer",
        competicao: "Liga",
      },
    });
  }
  return bet;
}

describe("interseção entre Matching e Pendências sharp", () => {
  it("aposta nas duas filas é contada uma vez", async () => {
    await apostaSemMatch({ comCaso: true, nome: "A vs B" });
    await apostaSemMatch({ comCaso: true, nome: "C vs D" });
    await apostaSemMatch({ comCaso: false, nome: "E vs F" });

    const dados = await filas();
    expect(dados.semMatchTotal).toBe(3);
    expect(dados.pendentes).toBe(3);
    expect(dados.casosAbertos).toBe(2);
    expect(dados.sobrepostos, "as duas que estão nas duas filas").toBe(2);

    // O que a tela soma: casos + (sem match − sobrepostos) = 2 + (3 − 2) = 3.
    const fila = dados.casosAbertos + Math.max(0, dados.semMatchTotal - dados.sobrepostos);
    expect(fila, "3 apostas distintas exigem ação, não 5").toBe(3);
  });

  it("sem sobreposição, a soma continua sendo a soma", async () => {
    await apostaSemMatch({ comCaso: false, nome: "G vs H" });
    await apostaSemMatch({ comCaso: false, nome: "I vs J" });

    const dados = await filas();
    expect(dados.sobrepostos).toBe(0);
    expect(dados.semMatchTotal).toBe(2);
    expect(dados.casosAbertos).toBe(0);
  });

  it("a lista marca a sem par que também está em Vincular, pelo caso de treino aberto", async () => {
    const vincular = await apostaSemMatch({ comCaso: true, nome: "M vs N" });
    const fechado = await apostaSemMatch({ comCaso: true, nome: "O vs P" });
    await db.prisma.trainingCase.updateMany({ where: { betId: fechado.id }, data: { status: "RESOLVED_MANUAL" } });
    await apostaSemMatch({ comCaso: false, nome: "Q vs R" });

    const inLinkQueue = (await getSharpPendentes()).filter((p) => p.bet.trainingCases.length > 0).map((p) => p.betId);
    expect(inLinkQueue).toEqual([vincular.id]);
  });

  it("aposta soft-deletada sai das duas filas e da interseção", async () => {
    const bet = await apostaSemMatch({ comCaso: true, nome: "K vs L" });
    await db.prisma.bet.update({ where: { id: bet.id }, data: { deletedAt: new Date() } });

    expect(await filas()).toEqual({ semMatchTotal: 0, sobrepostos: 0, casosAbertos: 0, pendentes: 0 });
  });
});

describe("quando o caso de Vincular chega ao dono", () => {
  const agora = new Date("2026-09-24T20:00:00Z");
  const horas = (h: number) => new Date(agora.getTime() + h * 3_600_000);
  const candidato = { matchId: 1, home: "A", away: "B", league: "Liga", matchDate: "2026-09-24", score: 40, swapped: false };

  async function caso(nome: string, over: { data: Date; candidatos: boolean; kickoffInferido?: boolean }) {
    const bankroll = await db.prisma.bankroll.upsert({
      where: { slug: "banca" },
      update: {},
      create: { nome: "Banca", slug: "banca", valorUnidade: 50 },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: agora,
        bankrollId: bankroll.id,
        data: over.data,
        kickoffInferido: over.kickoffInferido ?? false,
        evento: nome,
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "Casa",
        odds: 1.8,
        stake: 1,
        status: "PENDING",
      },
    });
    await db.prisma.betSharp.create({ data: { betId: bet.id, identityStatus: "PENDING" } });
    await db.prisma.trainingCase.create({
      data: {
        betId: bet.id,
        status: "OPEN",
        evento: nome,
        esporte: "Soccer",
        candidatesJson: over.candidatos ? [candidato] : [],
      },
    });
    return bet;
  }

  it("espera o revival: com candidatos, até o início; sem candidatos, 6 h depois; sem horário, o fim do dia", async () => {
    await caso("Candidatos antes do jogo", { data: horas(3), candidatos: true });
    await caso("Candidatos no jogo", { data: horas(-0.1), candidatos: true });
    await caso("Sem candidato há 2 h", { data: horas(-2), candidatos: false });
    await caso("Sem candidato há 7 h", { data: horas(-7), candidatos: false });
    await caso("Sem horário hoje", { data: horas(-10), candidatos: true, kickoffInferido: true });
    await caso("Sem horário ontem", { data: horas(-25), candidatos: false, kickoffInferido: true });

    const visiveis = (await getCasosAbertos(agora)).map((c) => c.evento).sort();
    expect(visiveis).toEqual(["Candidatos no jogo", "Sem candidato há 7 h", "Sem horário ontem"]);
    expect(await countCasosAbertos(agora)).toBe(3);
  });

  it("a pendência sharp com caso ainda escondido não aponta para Vincular", async () => {
    const escondido = await caso("Antes do jogo", { data: horas(3), candidatos: true });
    const visivel = await caso("Já começou", { data: horas(-1), candidatos: true });

    const inLinkQueue = (await getSharpPendentes(agora))
      .filter((p) => p.bet.trainingCases.length > 0)
      .map((p) => p.betId);
    expect(inLinkQueue).toEqual([visivel.id]);
    expect(inLinkQueue).not.toContain(escondido.id);
  });

  it("as duas filas vêm pelo jogo mais antigo, não por quando o caso nasceu ou foi reprocessado", async () => {
    // Criadas fora da ordem dos jogos.
    const tarde = await apostaSemMatch({ comCaso: true, nome: "Tarde vs X", jogo: "2026-08-03T21:00:00Z" });
    const cedo = await apostaSemMatch({ comCaso: true, nome: "Cedo vs X", jogo: "2026-08-01T12:00:00Z" });
    const meio = await apostaSemMatch({ comCaso: true, nome: "Meio vs X", jogo: "2026-08-02T15:00:00Z" });
    // Reprocessar grava na linha da pendência; antes isso a mandava para o fim.
    await db.prisma.betSharp.update({ where: { betId: cedo.id }, data: { identityStatus: "UNMATCHED" } });

    expect((await getSharpPendentes()).map((p) => p.betId)).toEqual([cedo.id, meio.id, tarde.id]);
    expect((await getCasosAbertos()).map((c) => c.betId)).toEqual([cedo.id, meio.id, tarde.id]);
  });
});
