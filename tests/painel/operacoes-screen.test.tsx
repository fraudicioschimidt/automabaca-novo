import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, prefetch() {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/operacoes",
}));

import { DesignProvider } from "@/app/_design/kit/context";
import { OperacoesScreen } from "@/app/_design/screens/OperacoesScreen";
import { OPERACOES_MOCK } from "@/app/_design/mock/operacoes";
import type { OperacoesData } from "@/app/_design/action-contracts";

const SEM_LEITURA: OperacoesData = {
  ...OPERACOES_MOCK,
  available: false,
  matchingTotal: 0,
  sharpSemMatchTotal: 0,
  matchingSharpSobrepostos: 0,
  iaJudgeSuggestionTotal: 0,
  iaJudgeSuggestions: [],
  settlement: [],
  matching: [],
  sharp: [],
};

function texto(data: OperacoesData): string {
  const html = renderToStaticMarkup(
    <DesignProvider mode="light">
      <OperacoesScreen data={data} />
    </DesignProvider>,
  );
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

describe("cabeçalho de Operações", () => {
  it("banco fora não vira 'Tudo em dia'", () => {
    const t = texto(SEM_LEITURA);
    expect(t).toContain("Leitura indisponível");
    expect(t).not.toContain("Tudo em dia");
    expect(t).toContain("O banco não respondeu");
  });

  it("filas vazias com leitura continuam 'Tudo em dia'", () => {
    const t = texto({ ...SEM_LEITURA, available: true });
    expect(t).toContain("Tudo em dia");
    expect(t).not.toContain("Leitura indisponível");
  });
});
