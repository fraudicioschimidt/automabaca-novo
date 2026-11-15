import { useEffect, useId, useState, type ReactNode } from "react";
import { useDesign } from "../kit/context";

function normalizedWidth(value: unknown): number {
  return Math.max(1, Math.round(Number(value) || 1));
}

/**
 * Largura do primeiro desenho, antes de o gráfico se medir (o HTML do servidor
 * não sabe a largura da tela): a do cartão num desktop, inteiro ou meia
 * coluna. A medida corrige no primeiro quadro; o layout não depende disto.
 */
export const LARGURA_INICIAL = { inteira: 968, metade: 452 } as const;

/**
 * Mantém o viewBox na mesma largura renderizada do SVG. Isso permite preencher
 * o card sem comprimir horizontalmente textos, pontos e espessuras.
 */
export function useResponsiveChartWidth(fallbackWidth: number = LARGURA_INICIAL.inteira) {
  const [chartNode, setChartNode] = useState<Element | null>(null);
  const [chartWidth, setChartWidth] = useState(() => normalizedWidth(fallbackWidth));

  useEffect(() => {
    const node = chartNode;
    if (!node) return undefined;

    const measure = () => {
      const next = normalizedWidth(node.getBoundingClientRect().width);
      setChartWidth((current) => current === next ? current : next);
    };
    measure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [chartNode]);

  return { chartRef: setChartNode, chartWidth };
}

export function useChartId(prefix: string): string {
  return `${prefix}-${useId().replaceAll(":", "")}`;
}

export function ChartEmptyState({ height, children = "Sem dados suficientes para o gráfico." }: {
  height: number | string;
  children?: ReactNode;
}) {
  const { T } = useDesign();
  return (
    <div
      role="status"
      style={{
        height,
        display: "grid",
        placeItems: "center",
        border: `1px dashed ${T.border}`,
        borderRadius: T.radiusSm,
        color: T.textFaint,
        ...T.type.caption,
      }}
    >
      {children}
    </div>
  );
}
