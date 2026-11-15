"use client";
import type { CSSProperties } from "react";
import type { BarraGeom, Regua } from "../lib/barra-com-sinal";
import { useDesign } from "./context";

/**
 * Trilho de barra horizontal que carrega o SINAL na geometria: trilho, marca
 * do zero, barra e régua. Usado pelo `HBars` do Analyzer e pela lista de CLV do
 * `bankroll-stats`; a geometria vem toda de `lib/barra-com-sinal`, aqui só se pinta.
 */
export function TrilhoComSinal({
  geom,
  centrada,
  reguaPct,
  cor,
  altura = 14,
  raio = 4,
}: {
  geom: BarraGeom;
  centrada: boolean;
  reguaPct: number | null | undefined;
  cor: string;
  altura?: number;
  raio?: number;
}) {
  const { T } = useDesign();
  const marca: CSSProperties = { position: "absolute", top: 0, bottom: 0 };
  return (
    <div style={{ position: "relative", height: altura, flex: 1 }}>
      <div style={{ position: "absolute", inset: 0, background: T.inset, borderRadius: raio, overflow: "hidden" }}>
        {/* Sem a marca do zero, "à esquerda do meio" não significa nada. */}
        {centrada ? <span aria-hidden="true" style={{ ...marca, left: "50%", width: 1, background: T.border }} /> : null}
        <div style={{ ...marca, left: `${geom.esquerdaPct}%`, width: `${geom.larguraPct}%`, background: cor, borderRadius: raio }} />
      </div>
      {/* A régua fica FORA do trilho recortado: no limite da escala ela cai em
          100% e o `overflow: hidden` a engoliria justamente no caso extremo. */}
      {reguaPct == null ? null : (
        <span aria-hidden="true" data-regua="true" style={{ ...marca, left: `${reguaPct}%`, width: 1.5, transform: "translateX(-50%)", backgroundImage: `repeating-linear-gradient(to bottom, ${T.text} 0 3px, transparent 3px 6px)` }} />
      )}
    </div>
  );
}

/** Legenda da régua; some junto com ela (marca sem explicação vira decoração). */
export function LegendaDaRegua({
  referencia,
  reguaPct,
  recuo = 0,
}: {
  referencia: Regua | null | undefined;
  reguaPct: number | null | undefined;
  recuo?: number;
}) {
  const { T } = useDesign();
  if (!referencia || reguaPct == null) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: recuo, ...T.type.caption, color: T.textFaint }}>
      <span aria-hidden="true" style={{ width: 12, borderTop: `1.5px dashed ${T.text}` }} />
      {referencia.rotulo}
    </div>
  );
}
