"use client";

import { useEffect, useEffectEvent, type RefObject } from "react";

type DialogEntry = { element: HTMLElement; previousFocus: HTMLElement | null };
const dialogs: DialogEntry[] = [];
let previousOverflow = "";
const FOCUSABLE = "a[href], button, input:not([type='hidden']), select, textarea, [tabindex]";

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => {
    if (element.tabIndex < 0 || element.matches(":disabled") || element.closest("[hidden], [inert], [aria-hidden='true']")) return false;
    for (let ancestor: HTMLElement | null = element; ancestor && dialog.contains(ancestor); ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  });
}

/** Foco, Escape e scroll pertencem ao modal superior, inclusive em sobreposição. */
export function useDialogLifecycle({
  dialogRef, initialFocusRef, onClose, initialFocusSelector, returnFocus,
}: {
  dialogRef: RefObject<HTMLElement | null>;
  initialFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  initialFocusSelector?: string;
  returnFocus?: Element | null;
}): void {
  const closeDialog = useEffectEvent(onClose);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previous = returnFocus ?? document.activeElement;
    const entry: DialogEntry = {
      element: dialog,
      previousFocus: previous instanceof HTMLElement ? previous : null,
    };
    if (dialogs.length === 0) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    // React monta effects dos filhos antes dos pais. Um pai entra abaixo do
    // filho já aberto, mesmo quando os dois montam no mesmo commit.
    const childIndex = dialogs.findIndex((active) => dialog.contains(active.element));
    dialogs.splice(childIndex < 0 ? dialogs.length : childIndex, 0, entry);
    const isTop = () => dialogs.at(-1) === entry;
    const frame = requestAnimationFrame(() => {
      if (!isTop()) return;
      const candidates = focusableElements(dialog);
      const preferred = initialFocusSelector
        ? candidates.find((element) => element.matches(initialFocusSelector))
        : null;
      (preferred ?? initialFocusRef.current ?? candidates[0] ?? dialog).focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTop()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeDialog();
        return;
      }
      if (event.key !== "Tab") return;
      const candidates = focusableElements(dialog);
      const first = candidates[0] ?? dialog;
      const last = candidates.at(-1) ?? dialog;
      const active = document.activeElement;
      if (!candidates.includes(active as HTMLElement) || (event.shiftKey ? active === first : active === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown, true);
      const wasTop = isTop();
      dialogs.splice(dialogs.indexOf(entry), 1);
      for (const remaining of dialogs) {
        if (remaining.previousFocus && dialog.contains(remaining.previousFocus)) {
          remaining.previousFocus = entry.previousFocus;
        }
      }
      if (dialogs.length === 0) document.body.style.overflow = previousOverflow;
      if (!wasTop) return;
      const parent = dialogs.at(-1)?.element;
      const target = entry.previousFocus;
      if (target?.isConnected && (!parent || parent.contains(target))) target.focus();
      else parent?.focus();
    };
  }, [dialogRef, initialFocusRef, initialFocusSelector, returnFocus]);
}
