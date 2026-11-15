import { describe, expect, it } from "vitest";
import { classify, classifyLlmSeries } from "@/src/services/ops/slo/slo";

/**
 * `LIMITS.queue.p95DurationMs` é um default genérico aplicado a TODA fila.
 * `sharp.enrich` é bimodal por desenho: hit/cache encerra rápido, enquanto
 * miss percorre buscas limitadas do BridgeOdds e fallbacks sob um gate global.
 * Concorrência entre web e worker faz uma chamada esperar mais de um slot sem
 * erro nem retry. Alarme sem defeito por trás não é observabilidade, é ruído
 * que treina o operador a ignorar a lista.
 *
 * O que este portão impede NÃO é "o número estar errado" — é a fila de forma
 * conhecida voltar a ser medida pelo default genérico. É o espelho de
 * `tests/operacao/cadencia-vs-portoes.test.ts`: lá, constante que a realidade nunca
 * alcança; aqui, constante que a realidade cruza toda semana sem defeito.
 */
describe("fila de forma medida não é julgada pelo default genérico", () => {
  /**
   * Faixa de operação NORMAL medida em produção: 82 amostras, todas com
   * sucesso e sem retry.
   */
  const P95_OBSERVADO_MS = 362_259;
  const CAUDA_COM_CONTENCAO_DENTRO_DO_PLANO_MS = 420_000;

  function linhaDeFila(p95DurationMs: number) {
    return {
      kind: "queue",
      name: "sharp.enrich",
      samples: 24,
      errors: 0,
      retries: 0,
      retryPct: 0,
      successPct: 100,
      avgDurationMs: 900,
      p95DurationMs,
      p95QueueLagMs: 1_000,
      lastSeenAt: new Date("2026-08-17T12:00:00Z"),
    };
  }

  it("a operação normal medida NÃO abre incidente", () => {
    const resultado = classify(linhaDeFila(P95_OBSERVADO_MS));
    expect(resultado.reasons).toEqual([]);
    expect(resultado.status).toBe("healthy");
  });

  it("a contenção prevista depois do orçamento Bridge NÃO abre incidente", () => {
    expect(classify(linhaDeFila(CAUDA_COM_CONTENCAO_DENTRO_DO_PLANO_MS)).status).toBe("healthy");
  });

  it("uma cauda além da busca limitada ainda reprova — folga não é cegueira", () => {
    const resultado = classify(linhaDeFila(500_000));
    expect(resultado.status).toBe("breach");
    expect(resultado.reasons.join(" ")).toContain("p95");
  });

  it("atraso e execução somados preservam margem da janela financeira", () => {
    const resultado = classify({
      ...linhaDeFila(420_000),
      p95QueueLagMs: 200_000,
    });
    expect(resultado.status).toBe("breach");
    expect(resultado.reasons.join(" ")).toContain("atraso+execução");
  });

  it("erro e retentativa continuam reprovando, por mais rápida que a fila esteja", () => {
    // A folga é de DURAÇÃO. Ela não pode virar perdão para fila que falha.
    const comErro = classify({ ...linhaDeFila(1_000), successPct: 90, errors: 3 });
    expect(comErro.status).toBe("breach");

    const comRetryStorm = classify({ ...linhaDeFila(1_000), retries: 20, retryPct: 80 });
    expect(comRetryStorm.status).toBe("breach");
  });

  it("outra fila SEM limite próprio continua no default genérico de 120 s", () => {
    // O conserto é dirigido a uma fila medida, não um afrouxamento global.
    const outra = classify({ ...linhaDeFila(P95_OBSERVADO_MS), name: "closing.sync" });
    expect(outra.status).toBe("breach");
  });

  it("bridgeodds com espera de cadência de 40s não abre violação com 40s-45s", () => {
    const row = {
      kind: "provider" as const,
      name: "bridgeodds.opening-closing/:id",
      samples: 20,
      errors: 0,
      retries: 0,
      retryPct: 0,
      successPct: 100,
      avgDurationMs: 40_000,
      p95DurationMs: 45_000,
      p95QueueLagMs: null,
      lastSeenAt: new Date("2026-08-25T12:00:00Z"),
    };
    expect(classify(row).status).toBe("healthy");
    expect(classify({ ...row, p95DurationMs: 90_000 }).status).toBe("breach");
  });

  it("sport.resolve e capture.sport_resolve cobrem a varredura cascata medida de 412s", () => {
    const actionRow = {
      kind: "action" as const,
      name: "sport.resolve",
      samples: 50,
      errors: 0,
      retries: 0,
      retryPct: 0,
      successPct: 100,
      avgDurationMs: 250_000,
      p95DurationMs: 412_000,
      p95QueueLagMs: null,
      lastSeenAt: new Date("2026-08-25T12:00:00Z"),
    };
    const queueRow = {
      kind: "queue" as const,
      name: "capture.sport_resolve",
      samples: 50,
      errors: 0,
      retries: 0,
      retryPct: 0,
      successPct: 100,
      avgDurationMs: 250_000,
      p95DurationMs: 412_000,
      p95QueueLagMs: 2_000,
      lastSeenAt: new Date("2026-08-25T12:00:00Z"),
    };
    expect(classify(actionRow).status).toBe("healthy");
    expect(classify(queueRow).status).toBe("healthy");
    expect(classify({ ...actionRow, p95DurationMs: 600_000 }).status).toBe("breach");
    expect(classify({ ...queueRow, p95DurationMs: 600_000 }).status).toBe("breach");
  });

  it("provider.cadence aguardando slot BridgeOdds de 40s não abre incidente falso", () => {
    const row = {
      kind: "action" as const,
      name: "provider.cadence",
      samples: 50,
      errors: 0,
      retries: 5,
      retryPct: 10,
      successPct: 100,
      avgDurationMs: 25_000,
      p95DurationMs: 39_928,
      p95QueueLagMs: null,
      lastSeenAt: new Date("2026-09-14T12:00:00Z"),
    };
    expect(classify(row).status).toBe("healthy");
    expect(classify({ ...row, p95DurationMs: 70_000 }).status).toBe("breach");
  });

  it("sharp.continuation agendando reprocessamento diferido com p95 de 104s não abre incidente falso", () => {
    const row = {
      kind: "action" as const,
      name: "sharp.continuation",
      samples: 43,
      errors: 0,
      retries: 43,
      retryPct: 100,
      successPct: 100,
      avgDurationMs: 35_000,
      p95DurationMs: 103_724,
      p95QueueLagMs: null,
      lastSeenAt: new Date("2026-09-14T12:00:00Z"),
    };
    expect(classify(row).status).toBe("healthy");
    expect(classify({ ...row, p95DurationMs: 160_000 }).status).toBe("breach");
  });

  it("sharp.stage.identity e sharp.stage.price com chamadas externas não violam no p95 medido", () => {
    const identityRow = {
      kind: "action" as const,
      name: "sharp.stage.identity",
      samples: 30,
      errors: 0,
      retries: 2,
      retryPct: 6.6,
      successPct: 100,
      avgDurationMs: 2_000,
      p95DurationMs: 5_678,
      p95QueueLagMs: null,
      lastSeenAt: new Date("2026-09-14T12:00:00Z"),
    };
    const priceRow = {
      kind: "action" as const,
      name: "sharp.stage.price",
      samples: 30,
      errors: 0,
      retries: 1,
      retryPct: 3.3,
      successPct: 100,
      avgDurationMs: 3_000,
      p95DurationMs: 6_692,
      p95QueueLagMs: null,
      lastSeenAt: new Date("2026-09-14T12:00:00Z"),
    };
    expect(classify(identityRow).status).toBe("healthy");
    expect(classify(priceRow).status).toBe("healthy");
    expect(classify({ ...identityRow, p95DurationMs: 20_000 }).status).toBe("breach");
    expect(classify({ ...priceRow, p95DurationMs: 20_000 }).status).toBe("breach");
  });

  it("falha isolada de rede em amostra reduzida (< 20) classifica como warning sem breach", () => {
    const falhaIsolada = {
      kind: "provider" as const,
      name: "pinnacle17/match/odds",
      samples: 6,
      errors: 1,
      retries: 0,
      retryPct: 0,
      successPct: 83.3,
      avgDurationMs: 2_000,
      p95DurationMs: 4_000,
      p95QueueLagMs: null,
      lastSeenAt: new Date("2026-09-14T12:00:00Z"),
    };
    const resultado = classify(falhaIsolada);
    expect(resultado.status).toBe("warning");
    expect(resultado.reasons[0]).toContain("falha isolada em amostra reduzida");

    const falhaRecorrente = {
      ...falhaIsolada,
      errors: 2,
      successPct: 66.7,
    };
    const resultadoRecorrente = classify(falhaRecorrente);
    expect(resultadoRecorrente.status).toBe("breach");
    expect(resultadoRecorrente.reasons[0]).toContain("sucesso 66.7% < 95%");
  });
});

describe("séries de LLM", () => {
  const base = { name: "llm.content.mistral.ocr", samples: 10, errors: 0, retries: 10, successPct: 100, p95DurationMs: 28_000 };

  it("recusa de conteúdo e aceitação histórica não declaram queda do provider", () => {
    expect(classifyLlmSeries(base)).toMatchObject({ status: "warning" });
    expect(classifyLlmSeries({ ...base, name: "llm.attempt", errors: 10, retries: 0, successPct: 0 })).toMatchObject({ status: "warning" });
    expect(classifyLlmSeries({ ...base, name: "llm.transport.mistral.ocr", retries: 0, p95DurationMs: 14_000 })).toMatchObject({ status: "healthy" });
  });

  it("falha de transporte e requisição longa violam o próprio objetivo", () => {
    expect(classifyLlmSeries({ ...base, name: "llm.transport.mistral.ocr", retries: 0 })?.status).toBe("breach");
    expect(classifyLlmSeries({ ...base, name: "llm.transport.mistral.ocr", retries: 0, errors: 2, successPct: 80 })?.status).toBe("breach");
    expect(classifyLlmSeries({ ...base, name: "llm.transport.groq.chat", retries: 0 })?.status).toBe("breach");
    expect(classifyLlmSeries({ ...base, name: "llm.cascade", retries: 0, p95DurationMs: 60_000 })?.status).toBe("healthy");
    expect(classifyLlmSeries({ ...base, name: "llm.cascade", retries: 0, p95DurationMs: 310_000 })?.status).toBe("breach");
  });
});

describe("espera do post do Telegram na fila", () => {
  const linha = (name: string, p95QueueLagMs: number) => ({
    kind: "queue", name, samples: 40, errors: 0, retries: 0, retryPct: 0, successPct: 100,
    avgDurationMs: 2_000, p95DurationMs: 8_000, p95QueueLagMs, lastSeenAt: new Date("2026-09-23T12:00:00Z"),
  });

  it("telegram.updates reprova com p95 de espera acima de 1 min; outra fila ainda não", () => {
    const telegram = classify(linha("telegram.updates", 90_000));
    expect(telegram.status).toBe("breach");
    expect(telegram.reasons.join(" ")).toContain("atraso p95 90000ms > 60000ms");
    expect(classify(linha("telegram.updates", 45_000)).status).toBe("healthy");
    expect(classify(linha("closing.sync", 90_000)).status).toBe("healthy");
  });
});
