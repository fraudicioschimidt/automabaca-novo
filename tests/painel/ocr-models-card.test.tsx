import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { OcrModelsCard } from "@/app/_design/screens/operacoes/ocr-models-card";
import type { OcrModelsReport } from "@/src/services/painel/ocr-models";
import { MONITORAMENTO_MOCK } from "@/app/_design/mock/operacoes";

it("mostra indisponibilidade sem inventar zero chamadas e preserva filtros acessíveis", () => {
  const html = renderToStaticMarkup(<OcrModelsCard report={{ available: false, evaluation: true, generatedAt: new Date().toISOString(), periods: [], comparisons: [], readers: [] }} />);
  expect(html).toContain("Não foi possível carregar");
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain("7 dias");
  expect(html).not.toContain("0 / 0");
});

const row = (over: Partial<OcrModelsReport["periods"][number]["models"][number]>) => ({
  provider: "gemini", model: "gemini-3.1-flash-lite", endpoint: "generate", enabled: true, scope: "Imagem comum",
  attempts: 10, responses: 8, accepted: 6, complete: 6, drafts: 0, notBets: 0, rejected: 2, rateLimits: 0, errors: 0,
  fixedStake: 0, rejectedDraft: 1, rejectedReview: 1,
  averageMs: 3000, p95Ms: 5000, lastAt: new Date().toISOString(), lastResult: "accepted", lastStatusCode: 200,
  usefulAverageMs: 1000, usefulP95Ms: 1500, usefulSamples: 6,
  inputTokens: 0, outputTokens: 0, reasoningTokens: 0, pages: 0, usageSamples: 0, pricedSamples: 0,
  paidEquivalentUsd: null, costPerAcceptedUsd: null, reasons: {}, parkedUntil: null, parkedCredentials: 0,
  ...over,
});

const report: OcrModelsReport = {
  available: true, evaluation: true, generatedAt: new Date().toISOString(),
  periods: [{ days: 7, models: [row({})] }],
  comparisons: [{
    days: 7,
    tasks: [{
      task: "channel-image", randomized: true, items: 20, resolved: 17, withoutReading: 3,
      models: [{ provider: "gemini", model: "gemini-3.1-flash-lite", assigned: 12, accepted: 9, produced: 11,
        qualityLow: 0.47, qualityHigh: 0.93, rescueAttempts: 4, rescued: 2, uniqueFailures: 1 }],
    }],
    unresolved: [{ at: new Date("2026-09-19T12:00:00.000Z").toISOString(), task: "channel-image", modelsTried: 7, chatIdHash: "abc123def4567890", messageId: 71 }],
  }],
  readers: [{ days: 7, rows: [
    { kind: "rule", provider: null, model: null, endpoint: null, contractVersion: null, registered: 40, corrected: 4,
      fields: { evento: 0, mercado: 2, selecao: 1, linha: 1, odds: 0, stake: 1 } },
    { kind: "llm", provider: "mistral", model: "mistral-ocr-2512", endpoint: "ocr", contractVersion: "bet-extraction-v2", registered: 5, corrected: 1,
      fields: { evento: 0, mercado: 0, selecao: 0, linha: 0, odds: 1, stake: 0 } },
  ] }],
};

it("explica a comparação por item e não deixa amostra pequena passar como certeza", () => {
  const html = renderToStaticMarkup(<OcrModelsCard report={report} />);
  expect(html).toContain("Comparação por item");
  expect(html).toContain("primeira tentativa de cada item");
  expect(html).toContain("amostra pequena");
  expect(html).toContain("47–93%");
  expect(html).toContain("17 itens de 20 tiveram leitura completa");
  expect(html).toContain("rascunho sem número e");
});

it("mostra o motivo das rejeições e o tempo até uma leitura apta", () => {
  const html = renderToStaticMarkup(<OcrModelsCard report={report} />);
  expect(html).toContain("1 rejeição por falta de número · 1 rejeição por conteúdo");
  expect(html).toContain("p95 útil");
  expect(html).toContain("todas as respostas");
});

it("lista os itens sem leitura com a referência da mensagem", () => {
  const html = renderToStaticMarkup(<OcrModelsCard report={report} />);
  expect(html).toContain("Itens sem leitura de ninguém (1)");
  expect(html).toContain("tentado por 7 modelos");
  expect(html).toContain("mensagem 71");
});

it("mostra o modelo que saiu da rotação por estar indisponível para a conta", () => {
  const parked = { ...report, periods: [{ days: 7, models: [row({ model: "labs-leanstral-1-5-1", provider: "mistral", endpoint: "chat",
    parkedUntil: "2026-09-30T12:00:00.000Z", parkedCredentials: 1 })] }] };
  const html = renderToStaticMarkup(<OcrModelsCard report={parked} />);
  expect(html).toContain("Fora da rotação até 30/09/2026 em 1 chave: modelo indisponível para a conta. Tire-o da configuração.");
  expect(renderToStaticMarkup(<OcrModelsCard report={report} />)).not.toContain("Fora da rotação");
});

it("mostra o acerto conferido pelo dono por leitor, com o leitor por regra e o percentual por campo", () => {
  const html = renderToStaticMarkup(<OcrModelsCard report={report} />);
  expect(html).toContain("Acerto conferido por você");
  expect(html).toContain("Leitor por regra");
  expect(html).toContain("mistral-ocr-2512");
  expect(html).toContain("Mistral · OCR · contrato bet-extraction-v2");
  // 4 de 40 corrigidas; 2 de 40 no mercado; a linha tem coluna própria.
  expect(html).toContain("10,0%");
  expect(html).toContain("5,0%");
  expect(html).toMatch(/<th scope="col">Linha<\/th>/);
  expect(html).toContain("Remover a aposta não conta");
});

it("diz quando não houve aposta capturada no período e não mostra a reavaliação por stake fixa", () => {
  const html = renderToStaticMarkup(<OcrModelsCard report={{ ...report, readers: [] }} />);
  expect(html).toContain("Nenhuma aposta capturada no período.");
  expect(html).not.toContain("Reavaliações");
  expect(html).not.toContain("reavaliada");
});

it("as datas saem no fuso de São Paulo, qualquer que seja o do aparelho", () => {
  const html = renderToStaticMarkup(<OcrModelsCard report={{
    ...report,
    generatedAt: "2026-06-13T15:45:00.000Z",
    periods: [{ days: 7, models: [row({ lastAt: "2026-06-13T15:40:00.000Z", parkedUntil: "2026-06-20T02:00:00.000Z", parkedCredentials: 1 })] }],
  }} />);
  expect(html).toContain("Atualizado em 13/06 12:45");
  expect(html).toContain("Leitura aceita · 13/06 12:40");
  expect(html).toContain("Fora da rotação até 19/06/2026");
  expect(html).toContain("19/09 09:00 · channel-image");
});

it("o relatório do ?mock=1 tem data válida", () => {
  const html = renderToStaticMarkup(<OcrModelsCard report={MONITORAMENTO_MOCK.ocrModels} />);
  expect(html).not.toContain("Invalid Date");
  expect(html).toContain("Atualizado em 13/06 12:45");
});


it("não promete comparação direta quando o sorteio histórico não foi comprovado", () => {
  const mixed = { ...report, comparisons: report.comparisons.map((p) => ({ ...p, tasks: p.tasks.map((t) => ({ ...t, randomized: false })) })) };
  const html = renderToStaticMarkup(<OcrModelsCard report={mixed} />);
  expect(html).toContain("Sorteio não comprovado em toda a amostra");
  expect(html).not.toContain("Ordem fixa nesta tarefa");
  expect(html).not.toContain("dá para comparar direto");
});
