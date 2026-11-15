import type { PgBoss } from "pg-boss";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  releaseKeys: vi.fn(),
  semRecurso: vi.fn(async () => 0),
  liquidacao: vi.fn(async () => 0),
  saldo: vi.fn(async () => undefined),
  lucro: vi.fn(async () => undefined),
  ledger: vi.fn(async () => undefined),
  catalogo: vi.fn(async () => undefined),
  escritas: vi.fn(async () => undefined),
  expireTraining: vi.fn(async () => 0),
  dismissOrphans: vi.fn(async () => 0),
  logArchive: vi.fn(),
  slos: vi.fn(),
}));
vi.mock("@/src/services/sharp/enrich/training-cases", () => ({
  expireStaleTrainingCases: mocks.expireTraining,
  dismissOrphanTrainingCases: mocks.dismissOrphans,
}));
vi.mock("@/src/services/ops/log-archive-health", () => ({ checkLogArchiveHealth: mocks.logArchive }));
vi.mock("@/src/services/ops/slo/slo", () => ({ checkOperationalSlos: mocks.slos, purgeOldOperationalMetrics: vi.fn() }));

vi.mock("@/src/services/contas/drift", () => ({ checkContasDrift: mocks.saldo }));
vi.mock("@/src/services/ops/consistency/bet-ledger", () => ({
  checkBetLucroConsistency: mocks.lucro,
  checkBetLedgerConsistency: mocks.ledger,
}));
vi.mock("@/src/services/ops/consistency/mercado-catalogo", () => ({ checkMercadoForaDoCatalogo: mocks.catalogo }));
vi.mock("@/src/services/ops/consistency/escritas-fora-do-fluxo", () => ({ checkEscritasForaDoFluxo: mocks.escritas }));

vi.mock("@/src/services/ops/action-sources", () => ({
  reconcileOperationalActions: async () => ({}),
  reconcileMappedTelegramChannelActions: async () => 0,
}));
vi.mock("@/src/services/ops/action-resource-gc", () => ({
  resolverAcoesSemRecurso: mocks.semRecurso,
  resolverAcoesDeLiquidacaoResolvida: mocks.liquidacao,
  resolverRevisoesDeCapturaGravadas: async () => 0,
  apagarLegendaDeRevisoesEncerradas: async () => 0,
}));
vi.mock(import("@/src/services/capture/capture-review"), () => ({ reconcileCaptureRefusalClusters: async () => 0 }));
vi.mock("@/src/services/ops/dlq/handler", () => ({
  descartarDeadLettersSemAssunto: async () => 0,
  discardRetainedScheduledDeadLetters: async () => 0,
  releaseStuckTelegramKeys: mocks.releaseKeys,
}));

import {
  checkFinancialConsistency,
  checkObservability,
  checkReviewConsistency,
  closeStaleTrainingCases,
  reconcileOperationalInbox,
} from "@/src/jobs/maintenance-jobs";

it("falha na varredura das chaves do Telegram não derruba o resto da reconciliação", async () => {
  mocks.releaseKeys.mockRejectedValueOnce(new Error("pgboss fora"));
  await expect(reconcileOperationalInbox({} as PgBoss, [])).resolves.toBeUndefined();
  expect(mocks.semRecurso).toHaveBeenCalledOnce();
  expect(mocks.liquidacao).toHaveBeenCalledOnce();
});

it("o fechamento dos casos de treino roda os dois passos e devolve o que fechou", async () => {
  mocks.expireTraining.mockResolvedValueOnce(3);
  mocks.dismissOrphans.mockResolvedValueOnce(1);
  await expect(closeStaleTrainingCases()).resolves.toEqual({ expired: 3, orphans: 1 });
});

it("falha na expiração não impede os órfãos, e o job falha no fim para a retentativa", async () => {
  mocks.dismissOrphans.mockClear();
  const bancoFora = new Error("banco fora");
  mocks.expireTraining.mockRejectedValueOnce(bancoFora);
  await expect(closeStaleTrainingCases()).rejects.toBe(bancoFora);
  expect(mocks.dismissOrphans).toHaveBeenCalledOnce();
});

it("os SLOs são avaliados mesmo quando a saúde do arquivo de logs falha", async () => {
  const statusIlegivel = new Error("status.json ilegível");
  mocks.logArchive.mockRejectedValueOnce(statusIlegivel);
  await expect(checkObservability()).rejects.toBe(statusIlegivel);
  expect(mocks.slos).toHaveBeenCalledOnce();
});

it("falha na revisão diária não derruba nem repete a conferência do dinheiro", async () => {
  mocks.catalogo.mockRejectedValueOnce(new Error("catálogo quebrado"));

  await expect(checkFinancialConsistency()).resolves.toBeUndefined();
  await expect(checkReviewConsistency()).rejects.toThrow("catálogo quebrado");

  expect(mocks.saldo).toHaveBeenCalledOnce();
  expect(mocks.lucro).toHaveBeenCalledOnce();
  expect(mocks.ledger).toHaveBeenCalledOnce();
  // As outras checagens da mesma fila rodam mesmo depois da falha.
  expect(mocks.escritas).toHaveBeenCalledOnce();
});
