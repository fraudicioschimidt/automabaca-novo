import { describe, expect, it } from "vitest";
import { duracaoDoToast, ehErro, ERRO_MS, errorMessage } from "@/app/_design/toast";

/**
 * Erro na UI não pode ter a mesma vida útil de uma confirmação.
 *
 * O toast é o ÚNICO canal de erro das telas do design, incluindo o caminho de
 * dinheiro em Contas. Com a duração da confirmação, uma recusa como "Valor
 * excede o limite financeiro da conta." some antes de ser lida, com o modal
 * ainda aberto e o valor no campo. Falhar alto vale também na borda visual.
 *
 * O contrato de DURAÇÃO mora aqui porque é puro e a suíte roda em `node`. A
 * metade visual (× para dispensar, `role="alert"`) tem DOM de verdade e está no
 * `tests/browser/critical.spec.ts` — separar evita arrastar jsdom só por isto.
 */
describe("janela do toast", () => {
  it("erro dura mais que a janela em que a confirmação já sumiu", () => {
    const erro = duracaoDoToast("warn", false);
    const sucesso = duracaoDoToast("ok", false);
    const comDesfazer = duracaoDoToast("ok", true);
    expect(erro).toBe(ERRO_MS);
    expect(erro, "erro empatado com o sucesso — foi assim que a recusa sumiu").toBeGreaterThan(sucesso);
    expect(erro, "erro precisa durar mais até que a janela do Desfazer").toBeGreaterThan(comDesfazer);
  });

  it("erro tem teto: um toast eterno sobrevive à troca de rota", () => {
    // A pílula vive no <body>, fora da árvore de rotas — sem teto ela
    // reapareceria sobre outra tela.
    expect(Number.isFinite(ERRO_MS)).toBe(true);
    expect(ERRO_MS).toBeLessThanOrEqual(30000);
  });

  it("confirmação e informação seguem efêmeras", () => {
    expect(duracaoDoToast("ok", false)).toBe(2400);
    expect(duracaoDoToast("info", false)).toBe(2400);
    expect(duracaoDoToast(undefined, false)).toBe(2400);
  });

  it("só warn conta como erro", () => {
    expect(ehErro("warn")).toBe(true);
    expect(ehErro("ok")).toBe(false);
    expect(ehErro("info")).toBe(false);
    expect(ehErro(undefined)).toBe(false);
  });
});

describe("mensagem do erro no toast", () => {
  it("erro do servidor com digest (texto genérico do Next) usa o texto da tela", () => {
    const doNext = Object.assign(
      new Error("An error occurred in the Server Components render. The specific message is omitted in production builds."),
      { digest: "2338271430" },
    );
    expect(errorMessage(doNext, "Falha ao liquidar")).toBe("Falha ao liquidar");
  });

  it("recusa de negócio (criada no navegador, sem digest) mostra o texto do servidor", () => {
    expect(errorMessage(new Error("Aposta não encontrada neste tipster."), "Falha ao apagar")).toBe("Aposta não encontrada neste tipster.");
    expect(errorMessage("texto solto", "Falha")).toBe("Falha");
  });
});
