"use client";

import { startTransition, useDeferredValue, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { searchPanelAction } from "./command-actions";
import type { PanelSearchResult } from "@/src/services/painel/search";
import { NAV, NAV_SEQUENCE_MS, TECLA_PALETA } from "@/app/_design/lib/atalhos";
import { FolhaDeAtalhos } from "./FolhaDeAtalhos";
import styles from "./CommandPalette.module.css";

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };


function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * A folha do `?` não redigita tecla nenhuma. Os gerais e os de tela vêm de
 * `lib/atalhos` (o MESMO módulo que o `keydown` daqui e o das filas de Operações
 * consultam); os de navegação vêm de `NAV`, logo acima. Lista que diverge do
 * atalho real ensina o gesto errado — e atalho que existe e some da lista é a
 * mesma doença invertida: o operador conclui que não existe.
 */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // "busca" é o padrão; "atalhos" é a folha do `?`. Um modo em vez de um segundo
  // overlay: backdrop, foco preso, trava de rolagem e Esc já existem aqui, e
  // duplicá-los seria uma segunda implementação do mesmo diálogo modal, que é
  // justamente onde errar acessibilidade custa caro.
  const [modo, setModo] = useState<"busca" | "atalhos">("busca");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const [results, setResults] = useState<PanelSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const keySequence = useRef("");

  function showPalette(qual: "busca" | "atalhos" = "busca") {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFeedback(null);
    setModo(qual);
    setOpen(true);
  }

  function closePalette() {
    setOpen(false);
    setFeedback(null);
  }

  useEffect(() => {
    const onInstall = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPrompt); };
    window.addEventListener("beforeinstallprompt", onInstall);
    return () => window.removeEventListener("beforeinstallprompt", onInstall);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.matches("input, textarea, select, [contenteditable='true']");
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === TECLA_PALETA.abrir) {
        event.preventDefault();
        if (open) closePalette(); else showPalette();
        return;
      }
      if (!typing && !open && event.key === TECLA_PALETA.folha) { event.preventDefault(); showPalette("atalhos"); return; }
      if (!typing && !open && event.key === TECLA_PALETA.busca) { event.preventDefault(); showPalette(); return; }
      if (open && event.key === "Escape") { event.preventDefault(); closePalette(); return; }
      if (open || typing || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      keySequence.current =
        keySequence.current === TECLA_PALETA.navegar ? `${TECLA_PALETA.navegar}${key}` : key;
      const match = NAV.find((item) => item.shortcut.replace(" ", "").toLowerCase() === keySequence.current);
      if (match) { event.preventDefault(); keySequence.current = ""; router.push(match.href); }
      window.setTimeout(() => { keySequence.current = ""; }, NAV_SEQUENCE_MS);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, router]);

  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // A folha de atalhos não tem campo: cai no painel, que tem tabIndex=-1.
    const frame = requestAnimationFrame(() => (inputRef.current ?? panelRef.current)?.focus());
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open || deferredQuery.length < 2) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearching(true);
      setFeedback(null);
      searchPanelAction(deferredQuery)
        .then((rows) => { if (!cancelled) startTransition(() => setResults(rows)); })
        .catch((error) => { if (!cancelled) { setResults([]); setFeedback(errorMessage(error, "A busca falhou. Tente novamente.")); } })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 160);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [deferredQuery, open]);

  function navigate(href: string) {
    closePalette();
    setQuery("");
    router.push(href);
  }

  async function installApp() {
    if (!installPrompt) return;
    setFeedback(null);
    try {
      await installPrompt.prompt();
      await installPrompt.userChoice;
      setInstallPrompt(null);
    } catch (error) {
      setFeedback(errorMessage(error, "Não foi possível iniciar a instalação."));
    }
  }

  function onPanelKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" && document.activeElement === inputRef.current) {
      const first = deferredQuery.length >= 2 ? results[0] : NAV[0];
      if (first) { event.preventDefault(); navigate(first.href); }
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Tab") return;
    const actions = [...(panelRef.current?.querySelectorAll<HTMLElement>("[data-palette-action]:not([disabled])") ?? [])];
    if (event.key === "Tab") {
      const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>("input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      return;
    }
    if (!actions.length) return;
    event.preventDefault();
    const current = actions.indexOf(document.activeElement as HTMLElement);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = current < 0 ? (delta > 0 ? 0 : actions.length - 1) : (current + delta + actions.length) % actions.length;
    actions[next]?.focus();
  }

  if (!open) return null;

  if (modo === "atalhos") {
    return (
      <div className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closePalette(); }}>
        <div ref={panelRef} tabIndex={-1} className={styles.panel} role="dialog" aria-modal="true" aria-label="Atalhos de teclado">
          <div className={styles.searchWrap}>
            <span className={styles.searchIcon} aria-hidden="true">⌨</span>
            <span className={styles.search}>Atalhos de teclado</span>
            <span className={styles.key}>ESC</span>
          </div>
          <FolhaDeAtalhos />
          <div className={styles.footer}>
            <span>Atalhos de navegação não funcionam enquanto você digita num campo.</span>
          </div>
        </div>
      </div>
    );
  }

  const showNavigation = deferredQuery.length < 2;
  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closePalette(); }}>
      <div ref={panelRef} className={styles.panel} role="dialog" aria-modal="true" aria-label="Busca e comandos" onKeyDown={onPanelKeyDown}>
        <div className={styles.searchWrap}>
          <span className={styles.searchIcon} aria-hidden="true">⌕</span>
          <input ref={inputRef} value={query} onChange={(event) => { setQuery(event.target.value); setFeedback(null); if (event.target.value.trim().length < 2) { setResults([]); setSearching(false); } }} className={styles.search} placeholder="Buscar tipster, aposta, conta ou ação…" aria-label="Buscar" />
          <span className={styles.key}>ESC</span>
        </div>
        <div className={styles.content}>
          {feedback ? <div className={styles.feedback} role="alert">{feedback}</div> : null}
          {searching ? <div className={styles.empty} role="status">Buscando…</div> : null}
          {!searching && results.length ? <section className={styles.section}><div className={styles.label}>Resultados</div>{results.map((item) => <PaletteItem key={item.id} item={item} onOpen={() => navigate(item.href)} />)}</section> : null}
          {!searching && !showNavigation && !results.length && !feedback ? <div className={styles.empty}>Nenhum resultado para “{deferredQuery}”.</div> : null}
          {showNavigation ? <section className={styles.section}><div className={styles.label}>Navegar</div>{NAV.map((item) => <PaletteItem key={item.id} item={item} onOpen={() => navigate(item.href)} />)}</section> : null}
          {/* A seção só existe se tiver item. O "Instalar" é condicional ao
              navegador oferecer o prompt — e sem ele sobrava o rótulo "AÇÕES"
              sozinho no pé da paleta, que é o caso normal. */}
          {showNavigation && installPrompt ? <section className={styles.section}>
            <div className={styles.label}>Ações</div>
            <button type="button" data-palette-action className={styles.item} onClick={installApp}><span className={styles.itemMark}>↓</span><span className={styles.itemText}><span className={styles.title}>Instalar AutomaBACA</span><span className={styles.detail}>Abrir como aplicativo neste dispositivo</span></span></button>
          </section> : null}
        </div>
        <div className={styles.footer}><span><b>↑↓</b> explorar</span><span><b>Enter</b> abrir</span><span><b>G + letra</b> navegar</span><span><b>/</b> buscar</span><span><b>?</b> atalhos</span></div>
      </div>
    </div>
  );
}

function PaletteItem({ item, onOpen }: { item: { kind: string; title: string; detail: string; shortcut?: string }; onOpen: () => void }) {
  return <button type="button" data-palette-action className={styles.item} onClick={onOpen}><span className={styles.itemMark}>{item.kind.slice(0, 2).toUpperCase()}</span><span className={styles.itemText}><span className={styles.title}>{item.title}</span><span className={styles.detail}>{item.detail}</span></span>{item.shortcut ? <span className={styles.shortcut}>{item.shortcut}</span> : null}</button>;
}
