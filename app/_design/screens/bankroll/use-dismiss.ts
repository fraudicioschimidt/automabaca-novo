import { useEffect } from "react";

/** Fecha o popover num clique fora de `selector` e, se `escape`, na tecla Esc. */
export function useDismissOnOutside(open: boolean, setOpen: (open: false) => void, selector: string, escape: boolean) {
  useEffect(() => {
    if (!open) return;
    const h = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest(selector)) setOpen(false);
    };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', h);
    if (escape) document.addEventListener('keydown', k);
    return () => {
      document.removeEventListener('pointerdown', h);
      if (escape) document.removeEventListener('keydown', k);
    };
  }, [open, setOpen, selector, escape]);
}

/**
 * O menu de resultado é `fixed`: rolar a página o deixaria longe da linha.
 * A rolagem só passa a fechar depois de 150 ms, para não pegar a do próprio clique.
 * Rearma a cada menu aberto.
 */
export function useCloseOnScrollOrEscape(menu: object | null, close: (value: null) => void) {
  useEffect(() => {
    if (!menu) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(null); };
    const s = () => close(null);
    document.addEventListener('keydown', k);
    const scrollArmTimer = window.setTimeout(() => window.addEventListener('scroll', s, true), 150);
    return () => {
      window.clearTimeout(scrollArmTimer);
      document.removeEventListener('keydown', k);
      window.removeEventListener('scroll', s, true);
    };
  }, [menu, close]);
}
