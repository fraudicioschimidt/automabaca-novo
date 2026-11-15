// Tokens do tema das telas do design, por modo (light/dark). As telas leem o
// tema pelo contexto (`useDesign()` em `kit/context`); `getTheme` fica para quem
// renderiza fora dele (error/loading/404).

export type ThemeMode = "light" | "dark";

/** Cookie do tema escolhido: o `DesignScreen` grava, e o servidor lê em `app/_lib/theme-mode`. */
export const THEME_COOKIE = "theme";

/**
 * Movimento: os valores moram no `:root` de `app/globals.css` e isto aponta
 * para lá. Assim um valor só serve o CSS Module, o `globals.css` e o
 * `style={{}}` inline, e `prefers-reduced-motion` desliga os três de uma vez.
 */
export const MOTION = {
  fast: "var(--mo-fast)", // hover, chip, botão
  base: "var(--mo-base)", // popover, tooltip, aba, expandir
  slow: "var(--mo-slow)", // drawer, modal, sanfona
  enter: "var(--mo-enter)", // entrada (desacelera no fim)
  standard: "var(--mo-standard)",
  exit: "var(--mo-exit)",
};

const SANS = '"Geist", system-ui, sans-serif';
const MONO = '"Geist Mono", ui-monospace, monospace';
const TNUM = { fontVariantNumeric: "tabular-nums", fontFeatureSettings: '"tnum" 1' } as const;

// Escala tipográfica canônica; docs/DESIGN.md explica como evoluí-la. São
// tokens de FORMA (família/tamanho/peso/spacing); a COR vem dos tokens de cor.
// Texto = sans · número = mono+tabular.
const TYPE = {
  hero:      { fontFamily: SANS, fontSize: 46,   fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1.05 },
  h1:        { fontFamily: SANS, fontSize: 32,   fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1.05 },
  h1Detail:  { fontFamily: SANS, fontSize: 28,   fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1 },
  h3:        { fontFamily: SANS, fontSize: 17,   fontWeight: 600, letterSpacing: "-0.01em" },
  wordmark:  { fontFamily: SANS, fontSize: 17,   fontWeight: 600, letterSpacing: "-0.02em" },
  subtitle:  { fontFamily: SANS, fontSize: 14,   fontWeight: 400 },
  meta:      { fontFamily: SANS, fontSize: 13.5, fontWeight: 400 },
  rowTitle:  { fontFamily: SANS, fontSize: 13.5, fontWeight: 600 },
  link:      { fontFamily: SANS, fontSize: 13,   fontWeight: 600 },
  rowMeta:   { fontFamily: SANS, fontSize: 11.5, fontWeight: 400 },
  caption:   { fontFamily: SANS, fontSize: 12,   fontWeight: 400 },
  captionSm: { fontFamily: SANS, fontSize: 11.5, fontWeight: 400 },
  fine:      { fontFamily: SANS, fontSize: 11,   fontWeight: 400 },
  cap:       { fontFamily: SANS, fontSize: 10.5, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase" },
  capSm:     { fontFamily: SANS, fontSize: 9.5,  fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase" },
  capLg:     { fontFamily: SANS, fontSize: 11,   fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase" },
  metricBig:    { fontFamily: MONO, fontSize: 30,   fontWeight: 600, letterSpacing: "-0.02em", ...TNUM },
  metricDetail: { fontFamily: MONO, fontSize: 24,   fontWeight: 600, letterSpacing: "-0.02em", ...TNUM },
  metricMono:   { fontFamily: MONO, fontSize: 22,   fontWeight: 600, letterSpacing: "-0.02em", ...TNUM },
  balance:      { fontFamily: MONO, fontSize: 26,   fontWeight: 600, letterSpacing: "-0.02em", ...TNUM },
  amount:       { fontFamily: MONO, fontSize: 14.5, fontWeight: 600, ...TNUM },
  delta:        { fontFamily: MONO, fontSize: 12.5, fontWeight: 600, ...TNUM },
  navNum:       { fontFamily: MONO, fontSize: 11,   fontWeight: 500, ...TNUM },
} as const;

const DARK = {
  bg: "#0f0f11", surface: "#17171a", surface2: "#1e1e22", inset: "#000",
  border: "rgba(255,255,255,.08)", borderSoft: "rgba(255,255,255,.05)",
  // Tons do avatar do tipster sem foto, [fundo, texto]: terrosos para conversar
  // com o dourado, texto com 4,5:1 ou mais (no escuro, sobre surface e surface2).
  // Musgo, terracota, ardósia, oliva, ameixa, areia, petróleo.
  avatarTones: [
    ["rgba(128,166,96,.2)", "#bcd6a2"], ["rgba(214,122,86,.2)", "#f2b699"], ["rgba(122,150,184,.2)", "#b6c8de"],
    ["rgba(172,166,82,.2)", "#d8d39c"], ["rgba(178,112,148,.2)", "#e0b4cc"], ["rgba(204,168,112,.2)", "#e6cda0"],
    ["rgba(82,164,158,.2)", "#a2d6d1"],
  ] as ReadonlyArray<readonly [string, string]>,
  text: "#f4f3f1", textMuted: "#b8b7b2", textFaint: "#a4a39f",
  accent: "#d7ab63", brandAccent: "#d7ab63", accentText: "#1a1408", accentSoft: "rgba(215,171,99,.14)",
  pos: "#5ed1a0", posDisplay: "#5ed1a0", neg: "#f08a76", negDisplay: "#f08a76", negText: "#1a0d09", posSoft: "rgba(94,209,160,.13)", negSoft: "rgba(240,138,118,.13)",
  sidebar: "#0b0b0d", sidebarText: "#f4f3f1",
  chartLine: "#f08a76", chartLineDisplay: "#f08a76", chartFill: "rgba(240,138,118,.16)", chartClv: "#7fa0d8", chartClvDisplay: "#7fa0d8",
  // Séries de um gráfico com várias linhas, na ordem fixa (validada para
  // daltonismo entre vizinhas e com 3:1 ou mais contra o cartão, nos dois
  // temas); a cor segue a série, nunca a posição dela.
  chartSeries: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"],
};

const LIGHT: typeof DARK = {
  bg: "#f6f5f2", surface: "#ffffff", surface2: "#faf9f6", inset: "#f2f0ec",
  border: "rgba(20,18,14,.09)", borderSoft: "rgba(20,18,14,.055)",
  avatarTones: [
    ["#e2ead6", "#3d5626"], ["#f4ddd1", "#8a3a1c"], ["#dce3ec", "#34495f"],
    ["#e9e6cc", "#575317"], ["#eddde6", "#6a3150"], ["#f2e6cf", "#6f4f20"],
    ["#d5e8e5", "#1c5856"],
  ],
  text: "#1b1a17", textMuted: "#595853", textFaint: "#686763",
  accent: "#785822", brandAccent: "#a9803c", accentText: "#ffffff", accentSoft: "rgba(120,88,34,.12)",
  pos: "#11734e", posDisplay: "#1f9d6b", neg: "#a23f2b", negDisplay: "#d4654a", negText: "#1b0d09", posSoft: "rgba(17,115,78,.1)", negSoft: "rgba(162,63,43,.1)",
  sidebar: "#ffffff", sidebarText: "#1b1a17",
  chartLine: "#a23f2b", chartLineDisplay: "#d4654a", chartFill: "rgba(162,63,43,.14)", chartClv: "#3f64ad", chartClvDisplay: "#5b7fc7",
  chartSeries: ["#2a78d6", "#eb6834", "#199e70", "#c28000", "#d55181"],
};

function buildTheme(mode: ThemeMode) {
  const dark = mode === "dark";
  return {
    mode,
    motion: MOTION,
    font: { display: SANS, body: SANS, num: MONO },
    displayWeight: 600, displaySpacing: "-0.03em",
    radius: 20, radiusMd: 14, radiusSm: 10, radiusXs: 6, pill: 999,
    type: TYPE,
    // O traço de cada série de `chartSeries`, na mesma ordem e igual nos dois
    // temas: na deuteranopia a 2ª e a 4ª cor, e a 3ª e a 5ª, ficam quase
    // iguais, e o traço da 3ª e da 4ª as separa sem mexer na paleta.
    chartSeriesDash: ["", "", "8 6", "0.5 5", ""],
    cardShadow: dark ? "0 1px 0 rgba(255,255,255,.02), 0 20px 50px -30px rgba(0,0,0,.7)"
                     : "0 1px 2px rgba(20,18,14,.04), 0 22px 50px -34px rgba(20,18,14,.22)",
    ...(dark ? DARK : LIGHT),
  };
}

export type Theme = ReturnType<typeof buildTheme>;

// Um objeto por modo: o tema é imutável, e a identidade estável evita
// re-render de quem memoiza sobre ele.
const THEMES: Record<ThemeMode, Theme> = { light: buildTheme("light"), dark: buildTheme("dark") };

export function getTheme(mode: string | null | undefined): Theme {
  return mode === "dark" ? THEMES.dark : THEMES.light;
}
