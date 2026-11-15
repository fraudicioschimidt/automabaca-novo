// Toast das telas do design: pílula inferior-central com ponto colorido, fonte
// Geist, entrada/saída animadas e botão "Desfazer" (`opts.onUndo`). O tema vem
// do `data-theme` do documento (cookie do app); a cor do ponto é token do tema.
import { getTheme } from "./theme";

export type ToastKind = "ok" | "info" | "warn";
export type ToastOptions = { onUndo?: () => unknown; undoLabel?: string };

/** Janela de leitura de um erro. */
export const ERRO_MS = 12000;
const SUCESSO_MS = 2400;
const DESFAZER_MS = 5200;

/** `warn` é erro: a única sinalização de recusa que as telas têm. */
export function ehErro(kind: string | undefined): boolean {
  return kind === "warn";
}

/**
 * A mensagem do erro ou `fallback`. Erro de servidor que chega com `digest` traz
 * a mensagem genérica do Next (em inglês, sem o motivo): vale o texto da tela.
 * A recusa de negócio chega sem ele, com o texto do servidor (`unwrapAction`).
 */
export function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "digest" in error) return fallback;
  const message = typeof error === "object" && error !== null && "message" in error ? error.message : undefined;
  return typeof message === "string" && message ? message : fallback;
}

/** Quanto tempo a pílula fica na tela. Pura para ser testável sem DOM. */
export function duracaoDoToast(kind: string | undefined, temUndo: boolean): number {
  if (ehErro(kind)) return ERRO_MS;
  return temUndo ? DESFAZER_MS : SUCESSO_MS;
}

let root: HTMLElement | null = null;

/**
 * Monta a raiz e o `<style>` das animações (com o nonce da CSP). O DesignScreen
 * chama na montagem; antes disso `toast()` não faz nada, como nos testes de
 * componente, que não montam o DesignScreen.
 */
export function ensureToast(nonce: string | undefined): void {
  if (typeof document === "undefined" || root) return;
  const existing = document.getElementById("__toast_root");
  if (existing) {
    root = existing;
    return;
  }
  root = document.createElement("div");
  root.id = "__toast_root";
  root.style.cssText =
    "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9999;" +
    "display:flex;flex-direction:column;gap:10px;align-items:center;pointer-events:none;" +
    "font-family:Geist,system-ui,sans-serif";
  document.body.appendChild(root);
  const st = document.createElement("style");
  if (nonce) st.nonce = nonce;
  st.textContent =
    "@keyframes __toastIn{from{opacity:0;transform:translateY(10px) scale(.96)}to{opacity:1;transform:none}}" +
    "@keyframes __toastOut{to{opacity:0;transform:translateY(6px) scale(.98)}}";
  document.head.appendChild(st);
}

export function toast(msg: unknown, kind?: ToastKind, opts: ToastOptions = {}): void {
  if (!root) return;
  const container = root;
  const dark = document.documentElement.dataset.theme === "dark";
  const T = getTheme(dark ? "dark" : "light");
  const COLORS: Record<ToastKind, string> = { ok: T.pos, info: T.accent, warn: T.neg };
  const dot = (kind && COLORS[kind]) || COLORS.info;
  // `warn` é o único canal de erro das telas: com os 2,4s de uma confirmação,
  // a recusa sumia antes de ser lida. Erro ganha janela larga e o × para dispensar.
  const erro = ehErro(kind);
  const el = document.createElement("div");
  el.style.cssText =
    "pointer-events:auto;display:flex;align-items:center;gap:10px;padding:11px 14px;" +
    "border-radius:12px;font-size:13.5px;font-weight:500;letter-spacing:-0.01em;" +
    "box-shadow:0 12px 32px -10px rgba(0,0,0,.45);animation:__toastIn var(--mo-base) var(--mo-enter);max-width:420px;" +
    (dark
      ? "background:#1f1f23;color:#f4f3f1;border:1px solid rgba(255,255,255,.08);"
      : "background:#1b1a17;color:#faf9f6;border:1px solid rgba(0,0,0,.2);");
  const dotEl = document.createElement("span");
  dotEl.style.cssText = "width:8px;height:8px;border-radius:8px;flex-shrink:0;background:" + dot;
  el.appendChild(dotEl);
  const span = document.createElement("span");
  span.textContent = String(msg);
  el.appendChild(span);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    el.style.animation = "__toastOut .25s forwards";
    setTimeout(() => el.remove(), 260);
  };
  const onUndo = opts.onUndo;
  if (typeof onUndo === "function") {
    const btn = document.createElement("button");
    btn.textContent = opts.undoLabel || "Desfazer";
    btn.style.cssText =
      "margin-left:6px;flex-shrink:0;cursor:pointer;border:none;background:transparent;" +
      "font-family:inherit;font-size:13px;font-weight:700;color:" + dot + ";padding:4px 6px;border-radius:6px";
    btn.onmouseenter = () => { btn.style.background = dark ? "rgba(255,255,255,.08)" : "rgba(255,255,255,.12)"; };
    btn.onmouseleave = () => { btn.style.background = "transparent"; };
    btn.onclick = () => {
      finish();
      const showUndoFailure = () => toast("Não foi possível desfazer — recarregue.", "warn");
      try {
        const result = onUndo();
        if (result instanceof Object && "then" in result && typeof result.then === "function") {
          (result as PromiseLike<unknown>).then(undefined, showUndoFailure);
        }
      } catch {
        showUndoFailure();
      }
    };
    el.appendChild(btn);
  }
  if (erro) {
    const fechar = document.createElement("button");
    fechar.type = "button";
    fechar.setAttribute("aria-label", "Dispensar aviso");
    fechar.textContent = "×";
    fechar.style.cssText =
      "margin-left:6px;flex-shrink:0;cursor:pointer;border:none;background:transparent;" +
      "font-family:inherit;font-size:17px;line-height:1;font-weight:600;color:inherit;" +
      "opacity:.6;padding:2px 6px;border-radius:6px";
    fechar.onmouseenter = () => { fechar.style.opacity = "1"; };
    fechar.onmouseleave = () => { fechar.style.opacity = ".6"; };
    fechar.onclick = finish;
    el.appendChild(fechar);
    el.setAttribute("role", "alert");
  } else {
    el.setAttribute("role", "status");
  }
  container.appendChild(el);
  // Teto mesmo para erro: o toast vive no body, fora da árvore de rotas, e um
  // erro eterno sobreviveria à navegação e apareceria sobre outra tela.
  setTimeout(finish, duracaoDoToast(kind, typeof onUndo === "function"));
}
