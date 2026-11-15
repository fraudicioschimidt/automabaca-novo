import { describe, expect, it } from "vitest";
import { PerfTable } from "@/app/_design/screens/analyzer/tables";
import { renderDesignMarkup } from "../helpers/design-markup";

type Linha = Parameters<typeof PerfTable>[0]["rows"][number];

describe("tabela de desempenho do Analyzer", () => {
  it("acerto com uma casa, como nas outras telas", () => {
    const linha = { l: "0–5%", n: 12, stake: 12, lucro: 1.5, roi: 12.5, clv: 2.1, acerto: 54.28 } as unknown as Linha;
    const html = renderDesignMarkup(<PerfTable rows={[linha]} />);
    expect(html).toContain("54.3%");
    expect(html).not.toContain(">54%<");
  });
});
