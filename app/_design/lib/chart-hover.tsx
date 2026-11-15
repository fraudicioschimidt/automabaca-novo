"use client";

import { useCallback, useState, type MouseEvent, type ReactNode, type TouchEvent } from "react";
import { useDesign } from "../kit/context";

/**
 * Leitura no hover para gráficos SVG: crosshair e caixa de valores.
 *
 * O hook cuida do índice sob o cursor (mouse e toque) e os componentes
 * desenham; cada gráfico continua dono da própria escala. Só vale aplicar onde
 * existe valor que a tela não escreve: gráfico que já imprime todos os números
 * ganharia só um alvo de mouse a mais.
 *
 * Duas geometrias, dois mapeamentos:
 *  - `useChartHover`      série contínua: o x vira índice pelo passo entre pontos.
 *  - `useChartHoverFaixa` barras/categorias: o x cai DENTRO de uma fatia. Usar o
 *                         passo contínuo aqui erra meia barra nas pontas.
 */

type Geometria = { total: number; largura: number; padL?: number; padR?: number };
type Escala = { largura: number; padL?: number; padR?: number };
type EventoDoCursor = MouseEvent<Element> | TouchEvent<Element>;

/**
 * Índice da série contínua em `x` (coordenada do viewBox): existem `total - 1`
 * passos entre os pontos, e o ponto é o mais próximo (`round`).
 */
export function indiceDaSerie(x: number, { total, largura, padL = 0, padR = 0 }: Geometria): number | null {
  if (total < 1) return null;
  const passo = (largura - padL - padR) / Math.max(total - 1, 1);
  if (!(passo > 0)) return null;
  const bruto = Math.round((x - padL) / passo);
  return Math.max(0, Math.min(total - 1, bruto));
}

/**
 * Índice da faixa em `x`: existem `total` fatias, e a faixa é a que contém o
 * cursor (`floor`). Com `indiceDaSerie` numa barra, o cursor sobre a primeira
 * já cai na segunda depois do centro, e as faixas das pontas viram alvos de
 * meia largura.
 */
export function indiceDaFaixa(x: number, { total, largura, padL = 0, padR = 0 }: Geometria): number | null {
  if (total < 1) return null;
  const fatia = (largura - padL - padR) / total;
  if (!(fatia > 0)) return null;
  const bruto = Math.floor((x - padL) / fatia);
  return Math.max(0, Math.min(total - 1, bruto));
}

/** Converte o x de tela para a escala do viewBox. `null` se não der. */
function xNoViewBox(evento: EventoDoCursor, largura: number): number | null {
  const caixa = evento.currentTarget.getBoundingClientRect();
  if (caixa.width === 0) return null;
  const cliente = "touches" in evento ? evento.touches[0] : evento;
  if (cliente?.clientX == null) return null;
  return (cliente.clientX - caixa.left) * (largura / caixa.width);
}

function useIndiceSobCursor(
  total: number,
  { largura, padL = 0, padR = 0 }: Escala,
  indiceDe: (x: number, geometria: Geometria) => number | null,
) {
  const [indice, setIndice] = useState<number | null>(null);

  const mover = useCallback((evento: EventoDoCursor) => {
    const x = xNoViewBox(evento, largura);
    if (x == null) return;
    setIndice(indiceDe(x, { total, largura, padL, padR }));
  }, [total, largura, padL, padR, indiceDe]);

  const sair = useCallback(() => setIndice(null), []);

  return {
    indice,
    /** Espalhe no `<svg>`. `touchmove` é passivo: não bloqueia a rolagem. */
    handlers: {
      onMouseMove: mover,
      onMouseLeave: sair,
      onTouchStart: mover,
      onTouchMove: mover,
      onTouchEnd: sair,
    },
  };
}

/** Índice do ponto sob o cursor numa série contínua. */
export function useChartHover(total: number, escala: Escala) {
  return useIndiceSobCursor(total, escala, indiceDaSerie);
}

/** Índice da faixa sob o cursor, para barras e categorias. */
export function useChartHoverFaixa(total: number, escala: Escala) {
  return useIndiceSobCursor(total, escala, indiceDaFaixa);
}

/**
 * Realce da faixa inteira sob o cursor, não só da barra: o que acende é a área
 * que responde ao gesto, e isso ensina onde clicar.
 */
export function ChartRealce({ x, largura, topo, base }: { x: number; largura: number; topo: number; base: number }) {
  const { T } = useDesign();
  return (
    <rect
      x={x - largura / 2}
      y={topo}
      width={largura}
      height={Math.max(0, base - topo)}
      rx="6"
      fill={T.textFaint}
      opacity="0.07"
      style={{ pointerEvents: "none" }}
    />
  );
}

type PontoDestacado = { y: number; cor: string; r?: number };

/** Linha vertical + pontos destacados. Vai por último no `<svg>`, sobre o traço. */
export function ChartCrosshair({ x, topo, base, pontos = [] }: {
  x: number;
  topo: number;
  base: number;
  pontos?: readonly PontoDestacado[];
}) {
  const { T } = useDesign();
  return (
    <g style={{ pointerEvents: "none" }}>
      <line x1={x} x2={x} y1={topo} y2={base} stroke={T.textFaint} strokeWidth="1" strokeDasharray="3 3" opacity="0.55" />
      {pontos.map((p, i) => (
        <circle key={i} cx={x} cy={p.y} r={p.r ?? 5} fill={p.cor} stroke={T.surface} strokeWidth="2.5" />
      ))}
    </g>
  );
}

type LinhaDaLeitura = {
  rotulo: string;
  valor: ReactNode;
  cor?: string | null;
  tracejado?: boolean;
  corValor?: string | null;
};

/**
 * Onde a caixa de leitura abre (`left`, no pai do gráfico): do lado do cursor
 * que couber, preferindo a esquerda depois de 72% da largura. Num gráfico
 * estreito (celular) em que ela não cabe de nenhum lado, encosta na borda
 * direita em vez de sair do cartão.
 */
export function readoutLeft(x: number, width: number, boxWidth: number): string {
  const pct = (x / width) * 100;
  const fitsRight = x + 12 + boxWidth <= width;
  const fitsLeft = x - 12 - boxWidth >= 0;
  const prefersLeft = x / width > 0.72;
  if (fitsLeft && (prefersLeft || !fitsRight)) return `calc(${pct}% - ${boxWidth + 12}px)`;
  if (fitsRight) return `calc(${pct}% + 12px)`;
  return `${Math.max(0, width - boxWidth)}px`;
}

/**
 * Caixa de leitura. Precisa de um pai `position: relative`. `x`/`largura` estão
 * na escala do viewBox; a posição sai em porcentagem para continuar certa
 * quando o SVG estica.
 */
export function ChartReadout({ x, largura, titulo, linhas, rodape = null, topo = 2, larguraCaixa = 158 }: {
  x: number;
  largura: number;
  titulo?: ReactNode;
  linhas: readonly LinhaDaLeitura[];
  rodape?: ReactNode;
  topo?: number;
  larguraCaixa?: number;
}) {
  const { T } = useDesign();
  return (
    <div
      style={{
        position: "absolute",
        top: topo,
        left: readoutLeft(x, largura, larguraCaixa),
        width: larguraCaixa,
        background: T.surface,
        border: `1px solid ${T.border}`,
        borderRadius: T.radiusSm,
        boxShadow: T.cardShadow,
        padding: "10px 12px",
        pointerEvents: "none",
        zIndex: 2,
      }}
    >
      {titulo != null && (
        <div style={{ fontFamily: T.font.num, fontVariantNumeric: "tabular-nums", fontSize: 11, color: T.textFaint, marginBottom: linhas.length ? 8 : 0 }}>
          {titulo}
        </div>
      )}
      {linhas.map((linha) => (
        <div key={linha.rotulo} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3 }}>
          {linha.cor && (
            <span style={{ width: 14, flexShrink: 0, height: 0, borderTop: `2px ${linha.tracejado ? "dashed" : "solid"} ${linha.cor}` }} />
          )}
          <span style={{ fontFamily: T.font.body, fontSize: 12, color: T.textMuted, flex: 1 }}>{linha.rotulo}</span>
          <span style={{ fontFamily: T.font.num, fontVariantNumeric: "tabular-nums", fontSize: 12.5, fontWeight: 600, color: linha.corValor ?? T.text }}>
            {linha.valor}
          </span>
        </div>
      ))}
      {/* A participação no total vai no pé e discreta: é contexto, não o número
          que se veio ler. */}
      {rodape && (
        <div style={{ marginTop: 7, paddingTop: 6, borderTop: `1px solid ${T.borderSoft}`, fontFamily: T.font.body, fontSize: 11, color: T.textFaint }}>
          {rodape}
        </div>
      )}
    </div>
  );
}
