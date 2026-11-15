import { describe, expect, it } from "vitest";
import { trainingCaseReasonLabel, trainingCaseReasonTag } from "@/src/domain/training-case-reason";
import { isWaitingProviderTrainingReason } from "@/src/services/sharp/enrich/training-cases";

describe("motivo de rejeição do matching", () => {
  it("explica ausência e score insuficiente sem expor lista vazia muda", () => {
    expect(trainingCaseReasonLabel("no_results")).toMatch(/nenhuma partida/i);
    expect(trainingCaseReasonLabel("below_threshold")).toMatch(/score mínimo/i);
  });

  it("cota e cascata vazia não são trabalho humano", () => {
    expect(isWaitingProviderTrainingReason("budget_truncated")).toBe(true);
    expect(isWaitingProviderTrainingReason("esporte_Soccer_sem_match_nos_tiers")).toBe(true);
    expect(isWaitingProviderTrainingReason("llm_indisponivel")).toBe(true);
    expect(isWaitingProviderTrainingReason("deferred_alternatives")).toBe(true);
    expect(isWaitingProviderTrainingReason("pinnacle17_budget")).toBe(true);
    expect(isWaitingProviderTrainingReason("feed_unavailable")).toBe(true);
    expect(isWaitingProviderTrainingReason("past_event:no_results")).toBe(false);
    expect(isWaitingProviderTrainingReason("past_event:budget_truncated")).toBe(false);
    expect(isWaitingProviderTrainingReason("past_event:esporte_Soccer_sem_match_nos_tiers")).toBe(false);
    expect(isWaitingProviderTrainingReason("past_event:pinnacle17_budget")).toBe(false);
    expect(isWaitingProviderTrainingReason("below_threshold")).toBe(false);
  });

  it("preserva a causa anterior quando o evento já passou", () => {
    expect(trainingCaseReasonLabel("past_event:no_results")).toMatch(
      /evento já passou.*nenhuma partida/is,
    );
  });
});

describe("isWaitingProviderTrainingReason com prefixo past_event:", () => {
  it("retorna false imediatamente para past_event: mesmo se o motivo contiver termos de provedor", () => {
    expect(isWaitingProviderTrainingReason("past_event:budget_truncated")).toBe(false);
    expect(isWaitingProviderTrainingReason("past_event:sem_match_nos_tiers")).toBe(false);
    expect(isWaitingProviderTrainingReason("past_event:pinnacle17_budget")).toBe(false);
    expect(isWaitingProviderTrainingReason("past_event:feed_unavailable")).toBe(false);
    expect(isWaitingProviderTrainingReason("past_event:llm_indisponivel")).toBe(false);
    expect(isWaitingProviderTrainingReason("past_event:deferred_alternatives")).toBe(false);
    expect(isWaitingProviderTrainingReason("past_event:no_results")).toBe(false);
  });

  it("continua retornando true para motivos transitórios de provedor sem past_event:", () => {
    expect(isWaitingProviderTrainingReason("budget_truncated")).toBe(true);
    expect(isWaitingProviderTrainingReason("sem_match_nos_tiers")).toBe(true);
    expect(isWaitingProviderTrainingReason("pinnacle17_budget")).toBe(true);
    expect(isWaitingProviderTrainingReason("feed_unavailable")).toBe(true);
    expect(isWaitingProviderTrainingReason("llm_indisponivel")).toBe(true);
    expect(isWaitingProviderTrainingReason("deferred_alternatives")).toBe(true);
  });

  it("resume o motivo em poucas palavras para o selo de Vincular", () => {
    expect(trainingCaseReasonTag("auto_ambiguo_gap")).toBe("candidatos próximos");
    expect(trainingCaseReasonTag("past_event:no_results")).toBe("nenhum candidato");
    expect(trainingCaseReasonTag("esporte_Soccer_sem_match_nos_tiers")).toBe("nenhum provider achou");
    expect(trainingCaseReasonTag("motivo_novo")).toBe("busca recusada");
  });
});
