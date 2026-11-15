// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { GavetaDeApostas } from "@/app/_design/screens/analyzer/gaveta-de-apostas";
import { unpackAnalyzerBets } from "@/app/_design/lib/analyzer-pack";
import { ANALYZER_MOCK_DATA } from "@/app/_design/mock/analyzer-data";
import { renderClickable } from "../helpers/click-render";
let view: ReturnType<typeof renderClickable> | undefined;
afterEach(() => { view?.unmount(); view = undefined; });

describe("apostas do recorte", () => {
  it("pagina sem perder a contagem, o resumo ou a última aposta", () => {
    const base = unpackAnalyzerBets(ANALYZER_MOCK_DATA.bets)[0]!;
    const bets = Array.from({ length: 121 }, (_, i) => ({ ...base, id: `drawer-${i}`, evento: `Time ${i} vs Outro`, data: new Date(Date.UTC(2026, 0, 1, 0, i)) }));
    view = renderClickable(<GavetaDeApostas apostas={bets} resumo={[{ k: "Lucro", v: "+121u" }]} />);
    expect(view.container.querySelectorAll("a")).toHaveLength(50);
    expect(view.container.textContent).toContain("121 apostas");
    expect(view.container.textContent).toContain("+121u");
    expect(view.container.querySelector("a")!.getAttribute("href")).toContain("drawer-120");
    view.click("Próxima");
    expect(view.container.querySelectorAll("a")).toHaveLength(50);
    view.click("Próxima");
    expect(view.container.querySelectorAll("a")).toHaveLength(21);
    expect(view.container.querySelector("a:last-child")!.getAttribute("href")).toContain("drawer-0");
    expect(view.container.querySelector<HTMLButtonElement>("button:last-child")!.disabled).toBe(true);
    view.rerender(<GavetaDeApostas apostas={bets.slice(0, 2)} resumo={null} />);
    expect(view.container.querySelectorAll("a")).toHaveLength(2);
  });
});
