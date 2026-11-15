// @vitest-environment jsdom
import { act } from "react";
import { renderDesignMarkup } from "../helpers/design-markup";
import { renderClickable } from "../helpers/click-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionsCard } from "@/app/_design/screens/operacoes/actions-card";
import type { MonitoramentoData } from "@/app/_design/adapters/operacoes";
import { readAction } from "@/app/_design/lib/action-reading";

type Acao = MonitoramentoData["actions"][number];

function action(index: number, status: Acao["status"] = "OPEN"): Acao {
  return {
    id: `action-${index}`,
    title: `Ação ${index}`,
    description: "Revisar evidência.",
    reading: readAction({ title: `Ação ${index}`, description: "Revisar evidência.", actionType: "incident.review", evidence: null }),
    area: "teste",
    risk: "MEDIUM",
    status,
    owner: null,
    evidence: null,
    occurrences: 1,
    reopenCount: 0,
    when: "agora",
    whenRelativo: "agora",
    desde: "agora",
    desdeAbsoluto: "agora",
    href: null,
    resolutionNote: null,
  };
}

describe("cards de backlog operacional", () => {
  it("usa os totais das abas e sinaliza o restante da página", () => {
    const html = renderDesignMarkup(
      <ActionsCard
        actions={Array.from({ length: 25 }, (_, index) => action(index))}
        actionTotals={{ OPEN: 43, ACKED: 7, RESOLVED: 556 }}
        onAcknowledge={undefined}
        onResolve={undefined}
      />,
    );

    expect(html).toContain(">43</span>");
    expect(html).toContain(">556</span>");
    // O restante da página vem com a base e o CRITÉRIO — "+18" sozinho deixaria
    // o operador supor que as 25 exibidas são as mais recentes.
    expect(html).toContain("Exibindo 25 de 43 · maior prioridade primeiro");
  });

});

describe("caixa de ações em linhas", () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => { cleanup.splice(0).forEach((fn) => fn()); });

  /** A leitura sai do texto e da evidência, como no adaptador. */
  const comLeitura = (acao: Acao): Acao => ({ ...acao, reading: readAction({ ...acao, actionType: "incident.review" }) });
  const circuito: Acao = comLeitura({
    ...action(1),
    id: "circuito",
    title: "Circuito da BridgeOdds abriu 2 vezes",
    description: "A BridgeOdds falhou 5 vezes seguidas.\nAbertura e fechamento ficam na fila.\nConfira a cota.",
    risk: "HIGH",
    evidence: { provider: "bridgeodds", aberturas: 2 },
    occurrences: 2,
    when: "25/09 09:10",
    whenRelativo: "há 32 min",
  });
  const slo: Acao = comLeitura({ ...action(2), id: "slo", title: "SLO violado em sharp.enrich", description: "p95 acima do teto.", evidence: { samples: 9 } });

  function montar(props: Partial<Parameters<typeof ActionsCard>[0]> = {}) {
    const view = renderClickable(<ActionsCard actions={[circuito, slo]} {...props} />);
    cleanup.push(view.unmount);
    const linha = (titulo: string) => [...view.container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")]
      .find((button) => button.textContent?.includes(titulo))!;
    const abrir = (titulo: string) => act(() => { linha(titulo).click(); });
    return { ...view, linha, abrir };
  }

  it("a linha fechada mostra gravidade, título, resumo e recência, sem o resto do texto nem as evidências", () => {
    const { container, linha } = montar();
    const circuitoLinha = linha("Circuito da BridgeOdds");
    expect(circuitoLinha.getAttribute("aria-expanded")).toBe("false");
    expect(circuitoLinha.textContent).toContain("A BridgeOdds falhou 5 vezes seguidas.");
    expect(circuitoLinha.textContent).toContain("há 32 min");
    expect(circuitoLinha.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Gravidade alta");
    expect(container.textContent).not.toContain("Confira a cota.");
    expect(container.textContent).not.toContain("bridgeodds");
    expect(container.textContent).not.toContain("2 ocorrências");
  });

  it("clicar abre o texto completo, o histórico e as evidências; uma aberta por vez", () => {
    const { container, linha, abrir } = montar();
    abrir("Circuito da BridgeOdds");
    const aberta = linha("Circuito da BridgeOdds");
    expect(aberta.getAttribute("aria-expanded")).toBe("true");
    const corpo = container.ownerDocument.getElementById(aberta.getAttribute("aria-controls")!)!;
    expect(corpo.textContent).toContain("Confira a cota.");
    expect(corpo.textContent).toContain("2 ocorrências");
    expect(corpo.querySelector('dl[aria-label="Dados técnicos"]')?.textContent).toContain("bridgeodds");

    abrir("SLO violado");
    expect(linha("Circuito da BridgeOdds").getAttribute("aria-expanded")).toBe("false");
    expect(linha("Circuito da BridgeOdds").hasAttribute("aria-controls")).toBe(false);
    expect(container.textContent).not.toContain("bridgeodds");
    expect(container.textContent).toContain("Samples");

    abrir("SLO violado");
    expect(container.textContent).not.toContain("Samples");
  });

  it("Assumir e Resolver ficam fora do botão da linha e chamam as mesmas ações", async () => {
    const onAcknowledge = vi.fn(async (_id: string) => ({ ok: true as const }));
    const onResolve = vi.fn(async (_id: string) => ({ ok: true as const }));
    const { container, linha } = montar({ onAcknowledge, onResolve });
    expect(linha("Circuito da BridgeOdds").querySelector("button, a")).toBeNull();

    const botao = (texto: string) => [...container.querySelectorAll("button")].filter((b) => b.textContent === texto);
    expect(botao("Assumir")).toHaveLength(2);
    await act(async () => { botao("Assumir")[0]!.click(); });
    expect(onAcknowledge).toHaveBeenCalledWith("circuito");
    // Assumida, a ação sai das Abertas e a contagem acompanha.
    expect(container.textContent).not.toContain("Circuito da BridgeOdds");
    const aba = (nome: string) => [...container.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.startsWith(nome))!;
    expect(aba("Assumidas").textContent).toBe("Assumidas1");

    act(() => { (aba("Assumidas") as HTMLButtonElement).click(); });
    expect(aba("Assumidas").getAttribute("aria-selected")).toBe("true");
    expect(botao("Assumir")).toHaveLength(0);
    await act(async () => { botao("Resolver")[0]!.click(); });
    expect(onResolve).toHaveBeenCalledWith("circuito");
  });
});
