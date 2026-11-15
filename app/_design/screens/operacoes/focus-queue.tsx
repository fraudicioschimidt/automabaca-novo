import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { OpsCard } from "./ui-primitives";
import { toast } from "../../toast";
import { FOCUS_QUEUE_ACTION_DELAY_MS, FOCUS_QUEUE_ARROW, FOCUS_QUEUE_KEY, NAV_SEQUENCE_MS, TECLA_PALETA } from "../../lib/atalhos";
import { Tecla } from "../../kit/Tecla";
import { ICONS, Icon } from "../../kit/icons";
import styles from "./operacoes.module.css";
import foco from "./focus-queue.module.css";
import type { CssVarsStyle } from "../../kit/css-vars";

/**
 * As filas de Operações em modo foco: um caso por vez, com as ações como opções
 * grandes. Esta casca cuida do que é igual nas quatro (contagem, progresso,
 * navegação, teclado, avanço otimista e fim da fila); cada fila entrega o miolo
 * do caso, as opções e as teclas dela.
 */

/** A tecla age no caso em foco; fora da tela, ela o traz em vez de resolver às cegas. */
function isOnScreen(el: HTMLElement | null) {
  if (!el || typeof el.getBoundingClientRect !== "function") return true;
  const r = el.getBoundingClientRect();
  const height = window.innerHeight || document.documentElement.clientHeight;
  return r.bottom > 0 && r.top < height;
}

/** Atalho só vale com o foco na página: não em campo de texto nem em diálogo aberto. */
function isPageKey(e: KeyboardEvent) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return false;
  const target = e.target;
  if (!(target instanceof Element)) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return false;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return false;
  if (target.closest('[role="dialog"]')) return false;
  // Nas abas as setas são das abas; as teclas das filas continuam valendo ali.
  const arrow = e.key === FOCUS_QUEUE_KEY.previous || e.key === FOCUS_QUEUE_KEY.next;
  return !(arrow && target.closest('[role="tablist"]'));
}

/**
 * Estado da fila em foco. Os casos decididos aqui saem da navegação na hora,
 * sem esperar o servidor, e continuam fora até a tela remontar: a página
 * recarregada pode trazê-los de volta (o reprocessamento sharp não tira a aposta
 * da fila no servidor). Falha, ou `restore`, os devolve.
 */
export function useFocusQueue<T extends { id: string }>(items: readonly T[], serverTotal: number | null = null) {
  const [sent, setSent] = useState<ReadonlySet<string>>(() => new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  // O total do servidor só desconta os casos decididos depois que a página recarrega.
  const [load, setLoad] = useState({ total: serverTotal, sent: 0 });
  if (load.total !== serverTotal) setLoad({ total: serverTotal, sent: sent.size });

  const cases = items.filter((c) => !sent.has(c.id));
  const found = cases.findIndex((c) => c.id === focusId);
  const pos = found >= 0 ? found : 0;
  const current = cases[pos] ?? null;
  const remaining = Math.max(cases.length, (serverTotal ?? 0) - (sent.size - load.sent));
  const done = sent.size;

  const rootRef = useRef<HTMLDivElement>(null);
  const caseRef = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  const focusedAt = useRef(0);
  useEffect(() => {
    focusedAt.current = Date.now();
    if (!refocus.current) return;
    refocus.current = false;
    caseRef.current?.focus({ preventScroll: true });
  }, [current?.id]);

  const goTo = (id: string | null) => {
    // Quem resolve pelo teclado, pelo botão ou pela confirmação não perde o foco
    // para o <body> quando o botão some com o caso.
    const active = document.activeElement;
    refocus.current = Boolean(rootRef.current?.contains(active) || active?.closest('[role="dialog"]'));
    setFocusId(id);
  };

  const restore = (id: string) => setSent((s) => {
    const next = new Set(s);
    next.delete(id);
    return next;
  });

  /**
   * Tira os casos da fila e passa ao próximo que sobrou. `run` devolve false (ou
   * falha) quando o caso não saiu no servidor, e ele volta à fila; o aviso da
   * falha é de quem chama. O caso que acabou de entrar em foco ainda não foi
   * lido: a ação sobre ele (tecla, clique) é ignorada.
   */
  const resolveMany = (list: readonly T[], run: (item: T) => unknown) => {
    if (list.length === 0) return;
    const ids = new Set(list.map((item) => item.id));
    if (current && ids.has(current.id)) {
      if (Date.now() - focusedAt.current < FOCUS_QUEUE_ACTION_DELAY_MS) return;
      const after = cases.slice(pos + 1).find((c) => !ids.has(c.id)) ?? cases.find((c) => !ids.has(c.id)) ?? null;
      goTo(after?.id ?? null);
    } else if (current) {
      setFocusId(current.id);
    }
    setSent((s) => new Set([...s, ...ids]));
    for (const item of list) {
      try {
        Promise.resolve(run(item)).then((ok) => { if (ok === false) restore(item.id); }, () => restore(item.id));
      } catch {
        restore(item.id);
      }
    }
  };

  return {
    cases, current, pos, done, remaining,
    total: done + remaining,
    beyondPage: remaining - cases.length,
    previous: pos > 0 ? cases[pos - 1]! : null,
    next: cases[pos + 1] ?? null,
    rootRef, caseRef,
    goTo,
    restore,
    resolve: (item: T, run: (item: T) => unknown) => resolveMany([item], run),
    resolveMany,
  };
}

export type FocusQueueState<T extends { id: string }> = ReturnType<typeof useFocusQueue<T>>;

/** Uma dica do cabeçalho: as teclas (ou a faixa, com `range`) e o que fazem. */
export type FocusHint = { keys: readonly string[]; range?: boolean; label: string };

export function FocusQueue<T extends { id: string }>({
  queue, title, subtitle, aside, hints, announce, emptyText, onKey, renderCase, renderOptions, navAction,
}: {
  queue: FocusQueueState<T>;
  title: string;
  subtitle?: ReactNode;
  /** À direita do título: nota ou ação da fila inteira. */
  aside?: ReactNode;
  /** As teclas que o caso em foco escuta; a navegação entra sozinha no fim. */
  hints: (item: T) => readonly FocusHint[];
  /** O caso para o leitor de tela, como "Casa contra Fora". */
  announce: (item: T) => string;
  emptyText: string;
  /** A ação da tecla no caso em foco, ou undefined quando a tecla não é da fila. */
  onKey: (item: T, key: string) => (() => void) | undefined;
  renderCase: (item: T) => ReactNode;
  renderOptions: (item: T) => ReactNode;
  /** Entre "anterior" e "próximo": a saída que não é opção (o "Tentar mais tarde" do Vincular). */
  navAction?: (item: T) => ReactNode;
}) {
  const { current, pos, done, total, beyondPage, previous, next, rootRef, caseRef, goTo } = queue;
  // A tecla solta do "G depois letra" da paleta: a letra seguinte é da navegação, não da fila.
  const navPrefixAt = useRef(0);

  // Sem lista de dependências: o handler lê o caso da renderização atual. Na
  // captura da janela, para a tecla consumida aqui não chegar à paleta (o G do
  // Liquidar começaria o "G depois letra").
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (!current || !isPageKey(e)) return;
      if (e.key === FOCUS_QUEUE_KEY.previous || e.key === FOCUS_QUEUE_KEY.next) {
        const target = e.key === FOCUS_QUEUE_KEY.previous ? previous : next;
        if (!target) return;
        e.preventDefault();
        goTo(target.id);
        return;
      }
      if (Date.now() - navPrefixAt.current < NAV_SEQUENCE_MS) {
        navPrefixAt.current = 0;
        return;
      }
      const action = onKey(current, e.key);
      if (!action) {
        if (e.key.toLowerCase() === TECLA_PALETA.navegar) navPrefixAt.current = Date.now();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      // Tecla segurada não decide: a repetição cairia no caso seguinte.
      if (e.repeat) return;
      if (!isOnScreen(caseRef.current)) {
        caseRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
        toast("O atalho vale para o caso em foco — confira e repita a tecla.", "info");
        return;
      }
      action();
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  });

  const progress: CssVarsStyle = { "--mc-progress": `${total > 0 ? (done / total) * 100 : 0}%` };
  const end = beyondPage > 0
    ? { title: "Fim desta página", text: `Faltam ${beyondPage} caso${beyondPage === 1 ? "" : "s"}; eles aparecem quando a página recarregar.` }
    : { title: "Fila zerada", text: emptyText };

  return (
    <OpsCard pad={0} className={styles.flushCard}>
      <div ref={rootRef}>
        <div className={foco.head}>
          <div className={foco.titleRow}>
            <div className={foco.titleText}>
              <h3 className={styles.cardTitle}>{title}</h3>
              {subtitle ? <div className={styles.cardSubtitle}>{subtitle}</div> : null}
            </div>
            {aside ? <div className={foco.aside}>{aside}</div> : null}
          </div>
          {total > 0 ? (
            <div className={foco.progress}>
              <span className={foco.count}>{current ? done + pos + 1 : total} de {total}</span>
              <span className={foco.track} style={progress}><span className={foco.trackFill} /></span>
              {current ? (
                <span className={foco.hints}>
                  {hints(current).map((hint) => (
                    <Fragment key={hint.label}>
                      {hint.range
                        ? <><Tecla tom="muted">{hint.keys[0]}</Tecla>{hint.keys.length > 1 ? <>–<Tecla tom="muted">{hint.keys[1]}</Tecla></> : null}</>
                        : hint.keys.map((k) => <Tecla key={k} tom="muted">{k}</Tecla>)}
                      {" "}{hint.label}<span className={foco.hintSep}>·</span>
                    </Fragment>
                  ))}
                  <Tecla tom="muted">{FOCUS_QUEUE_ARROW.previous}</Tecla><Tecla tom="muted">{FOCUS_QUEUE_ARROW.next}</Tecla> navegar
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className={foco.srOnly} role="status" aria-live="polite" aria-atomic="true">
          {current ? `Caso ${done + pos + 1} de ${total}: ${announce(current)}` : `${end.title}. ${end.text}`}
        </div>

        {current ? (
          <div className={foco.body}>
            <div className={foco.case} ref={caseRef} tabIndex={-1}>{renderCase(current)}</div>
            <div className={foco.options}>{renderOptions(current)}</div>
            <div className={foco.nav}>
              <button type="button" className={foco.ghost} disabled={!previous}
                onClick={() => previous && goTo(previous.id)} aria-keyshortcuts={FOCUS_QUEUE_KEY.previous}>
                <Icon d={ICONS.back} s={13} />anterior
              </button>
              {navAction?.(current)}
              <button type="button" className={foco.ghost} disabled={!next}
                onClick={() => next && goTo(next.id)} aria-keyshortcuts={FOCUS_QUEUE_KEY.next}>
                próximo<Icon d={ICONS.chevronRight} s={13} />
              </button>
            </div>
          </div>
        ) : (
          <div className={foco.done} ref={caseRef} tabIndex={-1}>
            <div className={foco.doneTitle}>{end.title}</div>
            <div className={foco.doneText}>{end.text}</div>
          </div>
        )}

        {current && beyondPage > 0 ? (
          <div className={foco.footer}>+{beyondPage} mais na fila além desta página</div>
        ) : null}
      </div>
    </OpsCard>
  );
}

/**
 * Uma opção do caso: a tecla (ou, sem ela, o marcador) à esquerda, o título e a
 * explicação, e o que a fila quiser à direita.
 */
export function FocusOption({ shortcut, marker, title, sub, trailing, tone, disabled = false, onChoose }: {
  /** A tecla que escolhe esta opção; sem permissão, a fila não a passa. */
  shortcut?: string;
  /** No lugar da tecla, quando não há: o número da posição, um ícone. */
  marker?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  trailing?: ReactNode;
  /** Cor do ponto à direita (ganhou, perdeu…), quando a opção tem um. */
  tone?: string;
  disabled?: boolean;
  onChoose: () => void;
}) {
  const toneStyle: CssVarsStyle | undefined = tone ? { "--mc-tone": tone } : undefined;
  return (
    <button type="button" onClick={onChoose} disabled={disabled} className={foco.option} style={toneStyle}
      aria-keyshortcuts={shortcut ? shortcut.toUpperCase() : undefined}>
      {shortcut
        ? <kbd className={foco.num} aria-hidden="true">{shortcut.toUpperCase()}</kbd>
        : <span className={foco.num} aria-hidden="true">{marker}</span>}
      <span className={foco.optionBody}>
        <span className={foco.optionTitle}>{title}</span>
        {sub ? <span className={foco.optionSub}>{sub}</span> : null}
      </span>
      {trailing}
      {tone ? <span className={foco.optionDot} aria-hidden="true" /> : null}
    </button>
  );
}
