"use client";
import { useId, useRef, type ReactNode } from "react";
import { useDesign } from "./context";
import { useDialogLifecycle } from "./use-dialog-lifecycle";

/** Formulário modal: foco inicial no primeiro campo, Escape, e envio só quando `canSubmit`. */
export function ModalForm({
  onClose,
  title,
  sub,
  children,
  onSubmit,
  submitLabel,
  submitTone,
  canSubmit = true,
  pending = false,
  width = 460,
}: {
  onClose: () => void;
  title: string;
  sub?: ReactNode;
  children: ReactNode;
  onSubmit: () => unknown;
  submitLabel: string;
  submitTone?: string;
  canSubmit?: boolean;
  pending?: boolean;
  width?: number;
}) {
  const { T } = useDesign();
  const dialogRef = useRef<HTMLFormElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useDialogLifecycle({
    dialogRef, initialFocusRef: closeRef, onClose,
    initialFocusSelector: "input, select, textarea",
  });

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 200, display: "grid", placeItems: "center", padding: "clamp(12px, 4vw, 40px)", background: "rgba(18,16,12,.58)" }}>
      <form ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); if (canSubmit && !pending) onSubmit(); }}
        style={{ width: `min(100%, ${width}px)`, maxHeight: "calc(100dvh - 24px)", display: "flex", flexDirection: "column", background: T.surface, color: T.text, border: `1px solid ${T.border}`, borderRadius: T.radius, boxShadow: "0 40px 120px -30px rgba(0,0,0,.6)", overflow: "hidden", fontFamily: T.font.body }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: 22, borderBottom: `1px solid ${T.borderSoft}` }}>
          <div style={{ minWidth: 0 }}>
            <h2 id={titleId} style={{ margin: 0, fontFamily: T.font.display, fontSize: 21, fontWeight: 600, letterSpacing: "-0.02em", color: T.text }}>{title}</h2>
            {sub && <div style={{ fontSize: 13, color: T.textMuted, marginTop: 3 }}>{sub}</div>}
          </div>
          <button ref={closeRef} type="button" onClick={onClose} title="Fechar (Esc)" aria-label="Fechar"
            style={{ marginLeft: "auto", width: 44, height: 44, borderRadius: T.radiusSm, border: `1px solid ${T.border}`, background: "transparent", color: T.textMuted, cursor: "pointer", display: "grid", placeItems: "center", fontSize: 19, lineHeight: 1, flexShrink: 0 }}>×</button>
        </div>
        <div style={{ padding: 22, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>{children}</div>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", padding: 22, borderTop: `1px solid ${T.borderSoft}` }}>
          <button type="button" onClick={onClose} disabled={pending}
            style={{ minHeight: 44, fontFamily: T.font.body, fontSize: 14, fontWeight: 600, cursor: pending ? "default" : "pointer", padding: "10px 16px", borderRadius: T.radiusMd, border: `1px solid ${T.border}`, background: "transparent", color: T.text, opacity: pending ? 0.6 : 1 }}>Cancelar</button>
          <button type="submit" disabled={pending || !canSubmit}
            style={{ minHeight: 44, fontFamily: T.font.body, fontSize: 14, fontWeight: 600, cursor: (pending || !canSubmit) ? "default" : "pointer", padding: "10px 18px", borderRadius: T.radiusMd, border: "none", background: submitTone === "neg" ? T.neg : T.accent, color: submitTone === "neg" ? T.negText : T.accentText, opacity: (pending || !canSubmit) ? 0.55 : 1 }}>{pending ? "..." : submitLabel}</button>
        </div>
      </form>
    </div>
  );
}
