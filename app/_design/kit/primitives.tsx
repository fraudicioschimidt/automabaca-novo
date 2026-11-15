"use client";
// Primitivos das telas, todos a partir do tema do contexto. Todo estilo sai
// de `T` (theme.ts): nada de hex ou medida cravada fora do tema.
import type { CSSProperties, HTMLAttributes, MouseEvent, ReactNode, Ref } from "react";
import { uiHexA, uiReadableOn, uiStableIndex } from "../utils";
import { sharpModeLabel } from "../lib/sharp-mode";
import { useDesign } from "./context";
import { Icon } from "./icons";
import { porFaixa, type Faixa } from "./faixas";

/** Moldura da tela: sidebar + conteúdo, fundo e fonte do tema. */
export function AppShell({
  sidebar,
  children,
  style,
}: {
  sidebar: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const { T } = useDesign();
  return (
    <div className="app-shell" style={{
      display: "flex",
      width: "100%",
      minHeight: "100vh",
      background: T.bg,
      color: T.text,
      fontFamily: T.font.body,
      WebkitFontSmoothing: "antialiased",
      ...style,
    }}>
      {sidebar}
      {children}
    </div>
  );
}

/**
 * Painel base (card): superfície, borda, raio e sombra do tema; `pad`
 * configurável. `pad={null}` deixa o respiro para o `className` (ex.: um
 * `porFaixa`), que o `padding` inline venceria.
 */
export function Panel({ children, pad = 24, style, ...props }: HTMLAttributes<HTMLDivElement> & { pad?: number | string | null }) {
  const { T } = useDesign();
  return (
    <div {...props} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radius, boxShadow: T.cardShadow, ...(pad === null ? {} : { padding: pad }), ...style }}>
      {children}
    </div>
  );
}

/** Rótulo em maiúsculas. size: sm | md (padrão) | lg. Cor textFaint. */
export function Cap({ children, style, size }: { children?: ReactNode; style?: CSSProperties; size?: "sm" | "lg" }) {
  const { T } = useDesign();
  const t = size === "sm" ? T.type.capSm : size === "lg" ? T.type.capLg : T.type.cap;
  return <div style={{ ...t, color: T.textFaint, ...style }}>{children}</div>;
}

type BtnKind = "primary" | "pos" | "neg" | "ghost" | "soft";

/** Botão. kind: primary | pos | neg | ghost (padrão) | soft. size: md (padrão) | sm. */
export function Btn({
  icon,
  children,
  kind,
  onClick,
  disabled,
  size,
  style,
  title,
  type,
}: {
  icon?: string;
  children?: ReactNode;
  kind?: BtnKind;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  style?: CSSProperties;
  /** Por que o botão está travado, quando está. */
  title?: string;
  /** Dentro de um `<form>`: `submit` envia, `button` não. */
  type?: "button" | "submit";
}) {
  const { T } = useDesign();
  const sm = size === "sm";
  const s = {
    primary: { bg: T.accent, fg: T.accentText, bd: "none", sh: `0 6px 16px -8px ${uiHexA(T.accent, 0.6)}` },
    pos: { bg: T.posSoft, fg: T.pos, bd: `1px solid ${uiHexA(T.pos, 0.3)}`, sh: "none" },
    neg: { bg: T.negSoft, fg: T.neg, bd: `1px solid ${uiHexA(T.neg, 0.3)}`, sh: "none" },
    ghost: { bg: "transparent", fg: T.text, bd: `1px solid ${T.border}`, sh: "none" },
    soft: { bg: T.surface2, fg: T.textMuted, bd: `1px solid ${T.border}`, sh: "none" },
  }[kind || "ghost"];
  return (
    <button
      type={type}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.filter = "brightness(0.97)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.filter = "none"; e.currentTarget.style.transform = "none"; }}
      onMouseDown={(e) => { if (!disabled) e.currentTarget.style.transform = "scale(0.97)"; }}
      onMouseUp={(e) => { e.currentTarget.style.transform = "none"; }}
      style={{ display: "inline-flex", alignItems: "center", gap: 7, cursor: disabled ? "default" : "pointer", fontFamily: T.font.body, fontSize: sm ? 12.5 : 13.5, fontWeight: 600, padding: sm ? "7px 11px" : "9px 14px", borderRadius: T.radiusSm, border: s.bd, background: s.bg, color: s.fg, whiteSpace: "nowrap", boxShadow: s.sh, opacity: disabled ? 0.4 : 1, transition: `transform ${T.motion.fast}, filter ${T.motion.fast}`, letterSpacing: "-0.01em", ...style }}
    >
      {icon && <Icon d={icon} s={sm ? 14 : 15} />}
      {children}
    </button>
  );
}

type BadgeTone = "sharp" | "id" | "prova" | "auto" | "pos" | "neg" | "accent";

/** Chip/etiqueta. tone: sharp | id (padrão) | prova | auto | pos | neg | accent. */
export function Badge({ children, tone }: { children?: ReactNode; tone?: BadgeTone }) {
  const { T } = useDesign();
  const map: Record<BadgeTone, [string, string]> = {
    sharp: [T.accent, T.accentSoft],
    id: [T.textMuted, T.surface2],
    prova: [T.neg, T.negSoft],
    auto: [T.pos, T.posSoft],
    pos: [T.pos, T.posSoft],
    neg: [T.neg, T.negSoft],
    accent: [T.accent, T.accentSoft],
  };
  const [c, bg] = (tone && map[tone]) || map.id;
  return (
    <span style={{ fontFamily: T.font.body, fontSize: 11, fontWeight: 600, color: c, background: bg, padding: "3px 8px", borderRadius: T.radiusXs, whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

/**
 * Selo do modo de medição do tipster: ponto na cor do modo e o nome em texto,
 * sem caixa, para caber no meio de uma linha ("CLV · R$50/u"). O tamanho da
 * letra vem de quem o põe na linha.
 */
export function SharpModeTag({ mode, style }: { mode: string; style?: CSSProperties }) {
  const { T } = useDesign();
  const dot = mode === "CLV_ONLY" ? T.pos : mode === "IDENTITY_ONLY" ? (T.brandAccent || T.accent) : T.textFaint;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: T.font.body, fontWeight: 500, color: T.textMuted, whiteSpace: "nowrap", ...style }}>
      <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: "50%", background: dot, flexShrink: 0 }} />
      {sharpModeLabel(mode)}
    </span>
  );
}

/** Iniciais do avatar: das duas primeiras palavras ("Big Data" → "BD"), ou as duas primeiras letras de um nome de uma palavra ("Cestinha" → "CE"). */
function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean);
  const [first = "", second] = words;
  return (second ? first.slice(0, 1) + second.slice(0, 1) : first.slice(0, 2)).toUpperCase();
}

/**
 * Logo do tipster: a foto do canal ou, sem ela, as iniciais num tom da paleta
 * `avatarTones`, escolhido pelo slug (que não muda, ao contrário do nome) para
 * o tipster ter sempre o mesmo tom. Sem `toneKey` (a carteira, o conjunto dos
 * tipsters) fica no dourado da marca. `s` aceita um tamanho por faixa.
 */
export function BankrollLogo({ name, logoUrl, toneKey, s = 40 }: {
  name: string;
  logoUrl?: string | null;
  toneKey: string | null;
  s?: number | Faixa<number>;
}) {
  const { T } = useDesign();
  const faixa = typeof s === "number" ? null : s;
  const base = typeof s === "number" ? s : s.largo;
  const box = (fixo: CSSProperties) => faixa
    ? porFaixa({ borderRadius: base * 0.28, flexShrink: 0, overflow: "hidden", ...fixo }, {
      width: faixa, height: faixa,
      ...(logoUrl ? {} : { fontSize: { largo: faixa.largo * 0.34, medio: (faixa.medio ?? faixa.largo) * 0.34, compacto: (faixa.compacto ?? faixa.medio ?? faixa.largo) * 0.34 } }),
    })
    : { style: { width: base, height: base, borderRadius: base * 0.28, flexShrink: 0, overflow: "hidden", ...(logoUrl ? {} : { fontSize: base * 0.34 }), ...fixo } };
  if (logoUrl) {
    return (
      <div {...box({ background: T.surface2, border: `1px solid ${T.borderSoft}` })}>
        {/* eslint-disable-next-line @next/next/no-img-element -- URL cadastrada pelo dono, de qualquer host: o next/image exigiria allowlist de domínios. */}
        <img src={logoUrl} alt={name} width={base} height={base} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      </div>
    );
  }
  const gold = T.brandAccent || T.accent;
  const [bg, fg] = toneKey === null ? [gold, uiReadableOn(gold)] : T.avatarTones[uiStableIndex(toneKey, T.avatarTones.length)] ?? [gold, uiReadableOn(gold)];
  return (
    <div aria-hidden="true" {...box({ display: "grid", placeItems: "center", fontFamily: T.font.body, fontWeight: 700, letterSpacing: "-0.02em", color: fg, background: bg })}>
      {initials(name)}
    </div>
  );
}

export function ModalSurface({
  children,
  style,
  ref,
  ...props
}: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }) {
  const { T } = useDesign();
  return (
    <div ref={ref} {...props} style={{ background: T.surface, color: T.text, border: `1px solid ${T.border}`,
      borderRadius: T.radius, boxShadow: "0 40px 120px -30px rgba(0,0,0,.6)", fontFamily: T.font.body, ...style }}>
      {children}
    </div>
  );
}

export function ProductEmptyState({
  icon,
  title,
  description,
  action,
  minHeight = { largo: 280 },
  titleSize = { largo: 22 },
  padding = { largo: "40px 24px" },
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action: ReactNode;
  minHeight?: Faixa<number>;
  titleSize?: Faixa<number>;
  padding?: Faixa<string>;
}) {
  const { T } = useDesign();
  return (
    <div {...porFaixa({ display: "grid", placeItems: "center", textAlign: "center" }, { minHeight, padding })}>
      <div style={{ maxWidth: 430 }}>
        {icon}
        <h2 {...porFaixa({ margin: 0, fontFamily: T.font.display, fontWeight: 600, letterSpacing: "-0.025em", color: T.text }, { fontSize: titleSize })}>{title}</h2>
        <p style={{ margin: "9px auto 20px", fontFamily: T.font.body, fontSize: 13.5, lineHeight: 1.6, color: T.textMuted }}>{description}</p>
        {action}
      </div>
    </div>
  );
}

export function DataGrid({ columns, children, style, ...props }: HTMLAttributes<HTMLDivElement> & { columns: string }) {
  return <div {...props} style={{ display: "grid", gridTemplateColumns: columns, ...style }}>{children}</div>;
}
