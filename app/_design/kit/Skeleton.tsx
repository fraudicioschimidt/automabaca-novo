"use client";
import type { CSSProperties, ReactNode } from "react";
import { uiHexA } from "../utils";
import { useDesign } from "./context";
import styles from "./skeleton.module.css";
import { cssVars } from "./css-vars";

/**
 * Esqueleto de carregamento: imita a FORMA do que vai chegar e reserva o
 * espaço, para a página não saltar quando o dado chega. `aria-hidden`: quem
 * anuncia a espera é o contêiner (`SkeletonRegiao`).
 */
export function Skeleton({
  altura = 14,
  largura = "100%",
  raio,
  style,
}: {
  altura?: number | string;
  largura?: number | string;
  raio?: number;
  style?: CSSProperties;
}) {
  const { T } = useDesign();
  return (
    <div
      aria-hidden="true"
      className={styles.bloco}
      style={cssVars({
        "--sk-base": T.surface2,
        "--sk-brilho": uiHexA(T.textFaint, 0.16),
        "--sk-radius": raio != null ? `${raio}px` : `${T.radiusSm}px`,
        height: altura,
        width: largura,
        ...style,
      })}
    />
  );
}

/** Contêiner que anuncia a espera uma vez só, em vez de ruído por bloco. */
export function SkeletonRegiao({ rotulo = "Carregando…", children }: { rotulo?: string; children?: ReactNode }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" }}>
        {rotulo}
      </span>
      {children}
    </div>
  );
}
