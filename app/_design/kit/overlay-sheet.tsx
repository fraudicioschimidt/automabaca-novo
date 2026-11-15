"use client";
import { useId, useRef, type ReactNode } from "react";
import { useDesign } from "./context";
import { ModalSurface } from "./primitives";
import { useDialogLifecycle } from "./use-dialog-lifecycle";
import styles from "./overlay-sheet.module.css";
import type { CssVarsStyle } from "./css-vars";

/** Gaveta modal do design (focus trap, Escape, aria, scroll lock do body). */
export function Sheet({
  cardPad,
  onClose,
  children,
  title,
  sub,
  wide,
  height,
  focoDeVolta,
}: {
  /** Respiro fora do compacto (px ou valor CSS); no compacto é sempre 18px (overlay-sheet.module.css). */
  cardPad: number | string;
  onClose: () => void;
  children: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  wide?: boolean;
  /** Altura fora do compacto; no compacto a gaveta ocupa a tela. */
  height?: string | number;
  /**
   * Elemento que abriu a gaveta, capturado pelo chamador no clique. Com a gaveta
   * em `lazy`, o foco já foi para o <body> quando ela monta, e
   * `document.activeElement` na montagem devolveria o foco ao topo da página.
   */
  focoDeVolta?: Element | null;
}) {
  const { T } = useDesign();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useDialogLifecycle({
    dialogRef, initialFocusRef: closeRef, onClose,
    returnFocus: focoDeVolta,
  });

  const vars: CssVarsStyle = {
    "--sheet-width": `${wide ? 1040 : 720}px`,
    "--sheet-height": typeof height === "number" ? `${height}px` : height,
    "--sheet-border-soft": T.borderSoft,
    "--sheet-border": T.border,
    "--sheet-text": T.text,
    "--sheet-muted": T.textMuted,
    "--sheet-display": T.font.display,
    "--sheet-pad-largo": typeof cardPad === "number" ? `${cardPad}px` : cardPad,
    "--sheet-radius-sm": `${T.radiusSm}px`,
  };

  return (
    <div onClick={onClose} className={styles.overlay}>
      <ModalSurface ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}
        className={styles.surface} style={vars}>
        <div className={styles.header}>
          <div className={styles.headingGroup}>
            <h2 id={titleId} className={styles.title}>{title}</h2>
            {sub && <div className={styles.subtitle}>{sub}</div>}
          </div>
          <button ref={closeRef} type="button" onClick={onClose} title="Fechar (Esc)" aria-label="Fechar"
            className={styles.close}>×</button>
        </div>
        {children}
      </ModalSurface>
    </div>
  );
}
