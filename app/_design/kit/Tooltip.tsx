"use client";

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDesign } from "./context";
import styles from "./tooltip.module.css";
import type { CssVarsStyle } from "./css-vars";

/**
 * Tooltip do kit. Portal com `position: fixed` (vários cartões têm `overflow:
 * hidden` e recortariam o balão); o texto fica sempre no DOM para o
 * `aria-describedby`; abre no foco e no toque, não só no hover, e fecha com Escape.
 */

const MARGEM = 10; // respiro entre o balão e a borda da janela

export function Tooltip({
  children,
  titulo,
  texto,
  formula,
  style,
  bloco = false,
}: {
  children?: ReactNode;
  titulo?: ReactNode;
  texto: ReactNode;
  formula?: ReactNode;
  style?: CSSProperties;
  bloco?: boolean;
}) {
  const { T } = useDesign();
  const [aberto, setAberto] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const gatilhoRef = useRef<HTMLSpanElement>(null);
  const bolhaRef = useRef<HTMLDivElement>(null);
  const id = `tt-${useId().replaceAll(":", "")}`;

  const posicionar = useCallback(() => {
    const gatilho = gatilhoRef.current;
    const bolha = bolhaRef.current;
    if (!gatilho || !bolha) return;
    const g = gatilho.getBoundingClientRect();
    const b = bolha.getBoundingClientRect();
    // Acima por padrão; vira para baixo quando não cabe (topo da página).
    const cabeAcima = g.top - b.height - MARGEM >= 0;
    const top = cabeAcima ? g.top - b.height - 8 : g.bottom + 8;
    // Centraliza no gatilho e prende dentro da janela.
    const ideal = g.left + g.width / 2 - b.width / 2;
    const left = Math.max(MARGEM, Math.min(ideal, window.innerWidth - b.width - MARGEM));
    setPos({ top, left });
  }, []);

  useEffect(() => {
    if (!aberto) { setPos(null); return undefined; }
    // Mede depois de pintar: antes disso o balão ainda não tem largura.
    const frame = requestAnimationFrame(posicionar);
    const fechar = () => setAberto(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setAberto(false); };
    window.addEventListener("scroll", fechar, true);
    window.addEventListener("resize", fechar);
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", fechar, true);
      window.removeEventListener("resize", fechar);
      window.removeEventListener("keydown", onKey);
    };
  }, [aberto, posicionar]);

  const vars: CssVarsStyle = {
    "--tt-bg": T.surface,
    "--tt-fg": T.text,
    "--tt-fg-muted": T.textMuted,
    "--tt-border": T.border,
    "--tt-hint": T.textFaint,
    "--tt-ring": T.accent,
    "--tt-radius": `${T.radiusSm}px`,
    "--tt-font": T.font.body,
    "--tt-mono": T.font.num,
  };

  const balao = aberto && typeof document !== "undefined"
    ? createPortal(
        <div
          ref={bolhaRef}
          role="tooltip"
          aria-hidden="true"
          className={`${styles.bolha} ${pos ? styles.bolhaAberta : ""}`}
          style={{ ...vars, top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
        >
          {titulo ? <b className={styles.titulo}>{titulo}</b> : null}
          <span className={styles.corpo}>{texto}</span>
          {formula ? <span className={styles.formula}>{formula}</span> : null}
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <span
        ref={gatilhoRef}
        className={bloco ? `${styles.trigger} ${styles.triggerBloco}` : styles.trigger}
        style={{ ...vars, ...style }}
        tabIndex={0}
        aria-describedby={id}
        onMouseEnter={() => setAberto(true)}
        onMouseLeave={() => setAberto(false)}
        onFocus={() => setAberto(true)}
        onBlur={() => setAberto(false)}
        onClick={() => setAberto((v) => !v)}
      >
        {children}
      </span>
      {/* Sempre no DOM: é o que `aria-describedby` aponta. */}
      <span id={id} className={styles.sr}>
        {[titulo, texto, formula].filter(Boolean).join(". ")}
      </span>
      {balao}
    </>
  );
}
