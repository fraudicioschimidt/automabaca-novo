import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { computeLucroFromStatus } from "@/src/domain/lucro";
import { toNumber } from "@/src/domain/money";
import { resetEnvCacheForTests } from "@/src/infra/env";
import { periodKeyFor } from "@/src/providers/budget-config";
import { reportOperationalAction } from "@/src/services/ops/operational-actions";
import { countActiveDeadLetters } from "@/src/services/ops/dlq/pgboss-queues";
import { getRecentReleases } from "@/src/services/ops/release-verdict";
import { getOperationalSlos } from "@/src/services/ops/slo/slo";
import { getResumoDeReliquidacao } from "@/src/services/painel/aposta/reliquidacao";
import { getPainelOperationalActions } from "@/src/services/painel/operacoes/actions";
import { getProviderBudgets } from "@/src/services/painel/operacoes/budgets";
import { getCanaisMonitorados } from "@/src/services/painel/operacoes/channels";
import { getJobFailures } from "@/src/services/painel/operacoes/falhas";
import { countCasosAbertos, getMatchingOverlap } from "@/src/services/painel/operacoes/filas";
import { getSaudeMotor, workerVivo } from "@/src/services/painel/operacoes/saude";
import { getSettlementManual } from "@/src/services/painel/operacoes/settlement-manual";
import { getPendingIaJudgeSuggestionsPage } from "@/src/services/settlement/ia-judge/suggestions";
import { createTestDb, type TestDb } from "../helpers/db";
import { DEMO_ACTOR, demoChannelId, gerarDadosDemo, recusaForaDoDev } from "../../scripts/lib/dados-demo";
import { gerarOperacaoDemo } from "../../scripts/lib/dados-demo-operacao";

let db: TestDb;
const allowedChats = process.env.TELEGRAM_ALLOWED_CHATS;

beforeAll(() => {
  db = createTestDb();
  // O 👍 do canal vale do dono: sem ele, nenhuma entrada fica marcada como pega.
  process.env.TELEGRAM_ALLOWED_CHATS = "900000001";
  resetEnvCacheForTests();
});
afterAll(async () => {
  if (allowedChats === undefined) delete process.env.TELEGRAM_ALLOWED_CHATS;
  else process.env.TELEGRAM_ALLOWED_CHATS = allowedChats;
  resetEnvCacheForTests();
  await db.dispose();
});
beforeEach(async () => { await db.reset(); });

const demoBets = () => db.prisma.bet.findMany({
  where: { bankroll: { telegramChannelId: { in: [1, 2, 3, 4, 5, 6, 7, 8].map(demoChannelId) } } },
  include: { closing: true, bankroll: { select: { sharpMode: true, nome: true } } },
});

// O gerador grava centenas de apostas pelos serviços reais. Com a máquina livre
// leva segundos; com várias suítes da CI disputando o mesmo PC, passa de 60 s.
const GERACAO_TIMEOUT_MS = 240_000;

describe("dados de exemplo do banco de desenvolvimento", () => {
  it("recusa produção e banco que não é o PostgreSQL local", () => {
    const local = "postgresql://u:p@localhost:5432/automabaca";
    expect(recusaForaDoDev({ DATABASE_URL: local })).toBeNull();
    expect(recusaForaDoDev({ DATABASE_URL: "postgresql://u:p@127.0.0.1:5433/x" })).toBeNull();
    expect(recusaForaDoDev({ NODE_ENV: "production", DATABASE_URL: local })).toMatch(/production/);
    expect(recusaForaDoDev({ AUTOMABACA_PROCESS: "worker", DATABASE_URL: local })).toMatch(/AUTOMABACA_PROCESS/);
    expect(recusaForaDoDev({ DATABASE_URL: "postgresql://u:p@automabaca-db:5432/automabaca" })).toMatch(/automabaca-db/);
    expect(recusaForaDoDev({})).toMatch(/DATABASE_URL/);
  });

  it("grava histórico liquidado, pendentes e fechamentos coerentes, e refaz sem tocar no que não é dele", async () => {
    const alheia = await db.prisma.bankroll.create({ data: { nome: "Banca do dono", slug: "banca-do-dono" } });
    const apostaAlheia = await db.prisma.bet.create({ data: { bankrollId: alheia.id, data: new Date(), evento: "A vs B",
      esporte: "Soccer", sportResolvedAt: new Date(), mercado: "Money Line – Match", selecao: "A", odds: 2, stake: 1 } });

    const primeira = await gerarDadosDemo({ escala: 0.1 });
    const segunda = await gerarDadosDemo({ escala: 0.1 });
    const now = new Date();

    // Semente fixa: a segunda execução apaga a primeira inteira e grava o mesmo conjunto.
    expect(segunda.apagadas).toEqual({ bancas: 8, apostas: primeira.apostas });
    expect({ ...segunda, apagadas: null }).toEqual({ ...primeira, apagadas: null });
    expect(await db.prisma.bet.findUnique({ where: { id: apostaAlheia.id } })).not.toBeNull();
    expect(await db.prisma.bankroll.count()).toBe(9);

    const bets = await demoBets();
    expect(bets).toHaveLength(segunda.apostas);
    const settled = bets.filter((bet) => bet.status !== "PENDING");
    expect(settled.length).toBe(segunda.liquidadas);
    for (const bet of settled) {
      expect(bet.settledAt!.getTime()).toBeGreaterThan(bet.data.getTime());
      expect(bet.settledAt!.getTime()).toBeLessThanOrEqual(now.getTime());
      expect(bet.registradoEm.getTime()).toBeGreaterThanOrEqual(bet.sourcePostedAt!.getTime());
      if (bet.status !== "CASHOUT") {
        expect(toNumber(bet.lucro)).toBeCloseTo(computeLucroFromStatus({ status: bet.status, stake: toNumber(bet.stake), odds: toNumber(bet.odds) }), 6);
      }
    }
    const pending = bets.filter((bet) => bet.status === "PENDING");
    expect(pending.some((bet) => bet.data < now)).toBe(true);
    expect(pending.some((bet) => bet.data > now)).toBe(true);
    expect(bets.filter((bet) => bet.takenAt).every((bet) => bet.status === "PENDING")).toBe(true);
    expect(segunda.pegas).toBeGreaterThan(0);
    expect(segunda.liquidadasHoje).toBeGreaterThan(0);

    // CLV só na banca que mede; o confiável foi observado nos 10 min antes do apito.
    const reliable = bets.filter((bet) => bet.closing?.clvReliable);
    expect(reliable.length).toBe(segunda.comClvConfiavel);
    expect(reliable.length).toBeGreaterThan(0);
    for (const bet of reliable) {
      expect(bet.bankroll.sharpMode).toBe("CLV_ONLY");
      expect(bet.closing!.closingPriceObservedAt!.getTime()).toBeGreaterThanOrEqual(bet.registradoEm.getTime());
      expect(bet.closing!.closingPriceObservedAt!.getTime()).toBeLessThan(bet.data.getTime());
      expect(bet.data.getTime() - bet.closing!.closingPriceObservedAt!.getTime()).toBeLessThanOrEqual(10 * 60_000);
      expect(bet.closing!.fetchedAt!.getTime()).toBeGreaterThanOrEqual(bet.data.getTime());
    }
    expect(bets.filter((bet) => bet.closing).every((bet) => bet.bankroll.sharpMode === "CLV_ONLY")).toBe(true);

    // Sem conta, sem ledger e sem nome de time aprendido: só apostas e o que o fluxo delas grava.
    expect(await db.prisma.conta.count()).toBe(0);
    expect(await db.prisma.movimentacao.count()).toBe(0);
    expect(await db.prisma.teamTipsterName.count()).toBe(0);
    expect(await db.prisma.retiredBetSource.count()).toBe(0);
    expect(await db.prisma.auditEvent.count({ where: { action: "bankroll.create", actor: DEMO_ACTOR } })).toBe(8);
  }, GERACAO_TIMEOUT_MS);

  it("não apaga banca de canal de exemplo que ele não criou", async () => {
    const intrusa = await db.prisma.bankroll.create({ data: { nome: "Outra", slug: "outra", telegramChannelId: demoChannelId(3) } });
    await expect(gerarDadosDemo({ escala: 0.1 })).rejects.toThrow(/não foi criado/);
    expect(await db.prisma.bankroll.findUnique({ where: { id: intrusa.id } })).not.toBeNull();
    expect(await db.prisma.bet.count()).toBe(0);
  });

  it("preenche Operações e Monitoramento sem job pendente nem chamada externa, e refaz só o que é dele", async () => {
    // O que não é de exemplo e mora nas mesmas tabelas globais.
    const now = new Date();
    const acaoAlheia = await reportOperationalAction({
      source: "slo", key: "queue:alheia", area: "incidentes", actionType: "incident.review", title: "Ação do dono", description: "real",
    });
    const metricaAlheia = await db.prisma.operationalMetric.create({ data: { kind: "queue", name: "alheia", outcome: "success" } });
    const periodo = periodKeyFor("day", now);
    await db.prisma.providerBudget.create({ data: { provider: "pinnacle17", periodKey: periodo, spent: 100 } });
    // O pg-boss não é zerado entre arquivos do mesmo banco de teste: o que outra
    // suíte deixou na fila fica fora da conta.
    const jobsPendentes = () => db.prisma.$queryRaw<Array<{ id: string; name: string; data: unknown }>>`
      SELECT id::text, name, data FROM pgboss.job WHERE state IN ('created', 'retry', 'active')`;
    const pendentesAntes = new Set((await jobsPendentes()).map((job) => job.id));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await gerarDadosDemo({ escala: 0.1 });
    const primeira = await gerarOperacaoDemo();
    // A fila persiste entre arquivos; regenerar o exemplo preserva as
    // dead-letters alheias, assim como os jobs pendentes conferidos abaixo.
    const retainedOutsideDemo = await countActiveDeadLetters() - primeira.jobsRetidos;
    expect(retainedOutsideDemo).toBeGreaterThanOrEqual(0);
    await gerarDadosDemo({ escala: 0.1 });
    const segunda = await gerarOperacaoDemo();

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    // A segunda execução apaga a primeira inteira (heartbeat, ciclo de fechamento, a origem e a cópia de cada falha).
    expect(segunda.apagados).toMatchObject({ jobs: 2 + 2 * primeira.jobsFalhos, metricas: primeira.metricas, orcamentos: 3 });
    expect({ ...segunda, apagados: null }).toEqual({ ...primeira, apagados: null });

    // Nada que um worker local pegaria depois: nenhum job novo pendente, de fila alguma.
    expect((await jobsPendentes()).filter((job) => !pendentesAntes.has(job.id))).toEqual([]);

    const saude = await getSaudeMotor();
    expect(saude.dbOk).toBe(true);
    expect(workerVivo(saude)).toBe(true);
    expect(saude.ultimoClosing).not.toBeNull();

    // Operações: cada fila com casos que caem nela pelas regras reais.
    const liquidar = await getSettlementManual();
    expect(new Set(liquidar.map((row) => row.cause.kind))).toEqual(new Set(["inferred_kickoff", "unconfirmed_sport", "flashscore_refused", "stalled"]));
    expect(await countCasosAbertos()).toBe(segunda.vincular);
    expect((await getMatchingOverlap()).sobrepostos).toBe(segunda.vincular);
    const sugestoes = await getPendingIaJudgeSuggestionsPage();
    expect(sugestoes.total).toBe(segunda.homologar);
    const apostasSugeridas = await db.prisma.bet.findMany({ where: { id: { in: sugestoes.items.map((s) => s.betId) } } });
    expect(apostasSugeridas.every((bet) => bet.status === "PENDING" && bet.sportResolutionStatus === "CONFIRMED")).toBe(true);
    expect(liquidar.some((row) => sugestoes.items.some((s) => s.betId === row.betId))).toBe(false);

    // Monitoramento.
    const falhas = await getJobFailures();
    expect(falhas.disponivel).toBe(true);
    expect(falhas.retidas).toBe(retainedOutsideDemo + segunda.jobsRetidos);
    expect(falhas.grupos.some((g) => g.replayHabilitado)).toBe(true);
    expect(falhas.grupos.some((g) => g.replayable && !g.replayHabilitado)).toBe(true);
    expect(falhas.grupos.some((g) => !g.replayable)).toBe(true);
    expect(new Set((await getOperationalSlos(24)).map((row) => row.status))).toEqual(new Set(["healthy", "warning", "breach"]));
    const releases = await getRecentReleases(10, new Date());
    expect(new Set(releases.releases.map((r) => r.state))).toEqual(new Set(["sem_erro_novo", "erro_novo", "em_observacao"]));
    expect(releases.flaggedLast24h).toBe(1);
    const acoes = await getPainelOperationalActions();
    expect(acoes.totais.abertas).toBeGreaterThan(0);
    expect(acoes.totais.assumidas).toBeGreaterThan(0);
    expect(acoes.totais.encerradas).toBeGreaterThan(0);
    expect((await getResumoDeReliquidacao(new Date(now.getTime() - 86_400_000))).apostas).toBe(segunda.reliquidadas);
    expect((await getProviderBudgets()).map((b) => b.name).sort()).toEqual(["bridgeodds", "flashscore", "pinnacle17"]);
    const canais = await getCanaisMonitorados();
    expect(canais.canais).toHaveLength(8);
    expect(canais.canais.every((canal) => canal.parse.tentativas > 0)).toBe(true);
    expect(canais.canais.filter((canal) => canal.capturePaused)).toHaveLength(1);
    expect(canais.canais.reduce((total, canal) => total + canal.discarded.total, 0)).toBe(segunda.descartados);
    expect(canais.orfaos.map((orfao) => orfao.channelId)).toEqual([String(demoChannelId(9))]);

    // O que não é de exemplo continua lá, e o gasto do provider é o do dono mais o de uma execução.
    expect(await db.prisma.operationalAction.findUnique({ where: { id: acaoAlheia.id } })).not.toBeNull();
    expect(await db.prisma.operationalMetric.findUnique({ where: { id: metricaAlheia.id } })).not.toBeNull();
    const gasto = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "dev-demo.provider_budget", resourceId: `pinnacle17:${periodo}` } });
    const orcamento = await db.prisma.providerBudget.findUniqueOrThrow({ where: { provider_periodKey: { provider: "pinnacle17", periodKey: periodo } } });
    expect(orcamento.spent).toBe(100 + (gasto.details as { cost: number }).cost);
    expect(await db.prisma.auditEvent.count({ where: { action: "dev-demo.provider_budget" } })).toBe(3);
  }, GERACAO_TIMEOUT_MS);
});
