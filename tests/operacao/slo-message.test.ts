import { describe, expect, it } from "vitest";
import { mensagemSloViolado } from "@/src/services/ops/slo/slo-message";

/**
 * O alerta de SLO ia ao Telegram com os `reasons` crus ("p95 25087ms > 15000ms",
 * "sucesso 85.7% < 95%"). Os motivos continuam técnicos no painel; no chat
 * viram frase.
 */
describe("mensagem de SLO violado", () => {
  it("traduz taxa de sucesso de IA", () => {
    expect(mensagemSloViolado({
      kind: "provider",
      name: "llm.transport.gemini.generate",
      samples: 7,
      reasons: ["sucesso 85.7% < 95%"],
    })).toBe(
      "🐢 Serviço externo com problema: IA Gemini (generate)\n"
      + "• só 85.7% das chamadas deram certo (meta: 95%)\n"
      + "Base: 7 registros na última hora.",
    );
  });

  it("traduz lentidão em segundos e minutos", () => {
    const texto = mensagemSloViolado({
      kind: "queue",
      name: "sharp.enrich",
      samples: 12,
      reasons: ["p95 25087ms > 15000ms", "atraso p95 540000ms > 300000ms"],
    });
    expect(texto).toContain("🐢 Fila de tarefas com problema: sharp.enrich");
    expect(texto).toContain("• lento: as respostas levam até 25s (limite: 15s)");
    expect(texto).toContain("• tarefas esperando até 9 min para começar (limite: 5 min)");
  });

  it("disjuntor aberto aponta o provider, sem o sufixo técnico", () => {
    expect(mensagemSloViolado({
      kind: "provider",
      name: "flashscore.breaker",
      samples: 1,
      reasons: ["circuito do provider abriu 1 vez na janela"],
    })).toBe(
      "🐢 Serviço externo com problema: flashscore\n"
      + "• foi desligado por excesso de falhas 1 vez\n"
      + "Base: 1 registro na última hora.",
    );
  });

  it("motivo desconhecido passa como veio", () => {
    expect(mensagemSloViolado({ kind: "http", name: "/api/x", samples: 5, reasons: ["algo novo"] }))
      .toContain("• algo novo");
  });
});
