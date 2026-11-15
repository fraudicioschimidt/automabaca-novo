// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IaJudgeCard } from "@/app/_design/screens/operacoes/ia-judge-card";
import { FOCUS_QUEUE_KEY, IA_JUDGE_KEY } from "@/app/_design/lib/atalhos";
import { renderClickable } from "../helpers/click-render";
import { renderDesignMarkup } from "../helpers/design-markup";

const sugestao = (id: string, suggestedStatus: "WON" | "LOST" = "WON", sourceUrl: string | null = "https://www.sofascore.com/x") => ({
  id, betId: `bet-${id}`, home: `Casa ${id}`, away: "B", region: "Brasil · Série A", market: "Escanteios", pick: "Mais de 9.5",
  odds: 1.91, stake: 0.5, started: "há 14 h", suggestedStatus, valueFound: "12", confidence: 0.93,
  ruleBased: false, fromFlashscore: false,
  reason: "Sofascore registra 12 escanteios.", sourceUrl, provider: "gemini", at: "08/07 20:15",
});
type Sugestao = ReturnType<typeof sugestao>;
type Acao = (id: string, actionFn: unknown) => Promise<boolean>;

let view: ReturnType<typeof renderClickable> | undefined;
// O jsdom não faz layout: sem isto todo caso estaria "fora da tela" e a tecla só rolaria até ele.
let now = 0;
beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 0, y: 100, width: 600, height: 300 }));
  // Cada leitura do relógio anda 1 s: o caso em foco já teve tempo de ser lido quando a ação chega.
  now = 1_790_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
});
afterEach(() => { view?.unmount(); view = undefined; vi.restoreAllMocks(); document.body.replaceChildren(); });

const aprovar = vi.fn();
const rejeitar = vi.fn();

function montar(lista: Sugestao[], { canManage = true, total = lista.length, handle = vi.fn<Acao>(() => Promise.resolve(true)) } = {}) {
  view = renderClickable(
    <IaJudgeCard iajList={lista} iajTotal={total} handleIajAction={handle}
      onApproveIaJudge={aprovar} onRejectIaJudge={rejeitar} canManage={canManage} />,
  );
  const texto = () => view!.container.textContent ?? "";
  const tecla = (key: string, target: EventTarget = document.body) => {
    act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
  };
  return { handle, texto, tecla };
}

/** Deixa as promessas do `handleIajAction` assentarem. */
const assentar = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("Homologar em modo foco", () => {
  it("mostra a sugestão em foco com a confiança, o encontrado, a explicação, a fonte e as datas", () => {
    const { texto } = montar([sugestao("a"), sugestao("b")]);
    expect(texto()).toContain("1 de 2");
    expect(texto()).toContain("Casa a");
    expect(texto()).not.toContain("Casa b");
    expect(texto()).toContain("Sugerido: GANHA · confiança da IA 93%");
    expect(texto()).toContain('Encontrado: "12"');
    expect(texto()).toContain("Sofascore registra 12 escanteios.");
    expect(texto()).toContain("começou há 14 h");
    expect(texto()).toContain("Gerado em 08/07 20:15 · GEMINI");
    expect(view!.container.querySelector('a[href="https://www.sofascore.com/x"]')?.textContent).toBe("Ver fonte");
  });

  it("regra determinística não recebe o selo de confiança de um modelo de IA", () => {
    const { texto } = montar([{ ...sugestao("regra"),
      provider: "flashscore-stats", confidence: 1, ruleBased: true, fromFlashscore: true,
    }]);
    expect(texto()).toContain("Regra sobre os dados do FlashScore");
    expect(texto()).toContain("Dados do FlashScore");
    expect(texto()).not.toContain("confiança");
    expect(texto()).not.toContain("100%");
  });

  it("o modelo que lê o FlashScore conserva sua confiança de IA e identifica os dados", () => {
    const { texto } = montar([{ ...sugestao("modelo"), fromFlashscore: true, sourceUrl: null }]);
    expect(texto()).toContain("confiança da IA 93%");
    expect(texto()).toContain("Dados do FlashScore");
    expect(texto()).not.toContain("Regra sobre os dados do FlashScore");
  });

  it("aprovar pede a confirmação; confirmado, sai e passa à próxima", () => {
    const { handle, texto, tecla } = montar([sugestao("a"), sugestao("b", "LOST")]);
    tecla(IA_JUDGE_KEY.approve.toUpperCase());
    expect(handle).not.toHaveBeenCalled();
    expect(texto()).toContain("A sugestão será homologada como GANHA");
    view!.submit("Aprovar como GANHA");
    expect(handle).toHaveBeenCalledWith("a", aprovar);
    expect(texto()).toContain("Casa b");
    expect(texto()).toContain("2 de 2");
  });

  it("R rejeita direto e passa à próxima", () => {
    const { handle, texto, tecla } = montar([sugestao("a"), sugestao("b")]);
    tecla(IA_JUDGE_KEY.reject);
    expect(handle).toHaveBeenCalledWith("a", rejeitar);
    expect(texto()).toContain("Casa b");
  });

  it("G depois A é o atalho de navegação da paleta, não aprovar", () => {
    const { tecla } = montar([sugestao("a")]);
    // As duas teclas saem dentro da janela da sequência.
    vi.spyOn(Date, "now").mockReturnValue(now);
    tecla("g");
    tecla(IA_JUDGE_KEY.approve);
    expect(view!.container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("a tecla age só no caso em foco", () => {
    const { handle, tecla } = montar([sugestao("a"), sugestao("b"), sugestao("c")]);
    tecla(FOCUS_QUEUE_KEY.next);
    tecla(FOCUS_QUEUE_KEY.next);
    tecla(IA_JUDGE_KEY.reject);
    expect(handle).toHaveBeenCalledWith("c", rejeitar);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("se a ação falha, a sugestão volta à fila", async () => {
    const handle = vi.fn<Acao>(() => Promise.resolve(false));
    const { texto } = montar([sugestao("a")], { handle });
    view!.click("Rejeitar a sugestão");
    expect(texto()).toContain("Fila zerada");
    await assentar();
    expect(texto()).toContain("Casa a");
    expect(texto()).toContain("1 de 1");
  });

  it("decidida a última da página, o total do servidor vira 'Fim desta página'", () => {
    const { texto, tecla } = montar([sugestao("a")], { total: 3 });
    expect(texto()).toContain("+2 mais na fila além desta página");
    tecla(IA_JUDGE_KEY.reject);
    expect(texto()).toContain("Fim desta página");
    expect(texto()).toContain("Faltam 2 casos");
  });

  it("sem sugestões, o estado final", () => {
    const html = renderDesignMarkup(
      <IaJudgeCard iajList={[]} iajTotal={0} handleIajAction={() => Promise.resolve(true)} canManage />,
    );
    expect(html).toContain("Sugestões do IA-Judge");
    expect(html).toContain("Fila zerada");
  });

  it("sem permissão, as opções aparecem sem ação e as teclas não agem", () => {
    const { handle, tecla } = montar([sugestao("a")], { canManage: false });
    const opcoes = [...view!.container.querySelectorAll("button")].filter((b) => /Aprovar|Rejeitar/.test(b.textContent ?? ""));
    expect(opcoes).toHaveLength(2);
    expect(opcoes.every((b) => b.disabled)).toBe(true);
    tecla(IA_JUDGE_KEY.approve);
    tecla(IA_JUDGE_KEY.reject);
    expect(view!.container.querySelector('[role="dialog"]')).toBeNull();
    expect(handle).not.toHaveBeenCalled();
  });
});
