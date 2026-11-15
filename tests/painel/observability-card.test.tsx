import React from "react";
import { renderDesignMarkup } from "../helpers/design-markup";
import { describe, expect, it } from "vitest";
import { ObservabilityCard } from "@/app/_design/screens/operacoes/observability-card";

function row(name: string, status: "healthy" | "warning" | "breach", reasons: string[] = []) {
  return {
    id: name,
    kind: "provider",
    name,
    samples: 10,
    errors: status === "breach" ? 1 : 0,
    success: status === "breach" ? 90 : 100,
    p95: 100,
    lagP95: null,
    status,
    reasons,
    last: "25/08 10:30",
  };
}

describe("leitura operacional dos SLOs", () => {
  it("violações aparecem antes das linhas saudáveis e sempre declaram recência", () => {
    const html = renderDesignMarkup(
      <ObservabilityCard
        rows={[
          row("saudável", "healthy"),
          row("violado", "breach", ["p95 acima do limite"]),
          row("curto", "warning", ["amostra curta"]),
        ]}
      />,
    );
    expect(html.indexOf("violado")).toBeLessThan(html.indexOf("curto"));
    expect(html.indexOf("curto")).toBeLessThan(html.indexOf("saudável"));
    expect(html).toContain("p95 acima do limite · última 25/08 10:30");
  });
});
