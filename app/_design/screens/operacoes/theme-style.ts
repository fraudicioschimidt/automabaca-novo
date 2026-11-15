import type { CssVarsStyle } from "../../kit/css-vars";
import type { Theme } from "../../theme";

/**
 * Variáveis `--ops-*` que o `operacoes.module.css` lê. Operações e
 * Monitoramento penduram o mesmo conjunto na moldura da tela.
 */
export function opsThemeStyle(T: Theme): CssVarsStyle {
  return {
    "--ops-bg": T.bg,
    "--ops-surface": T.surface,
    "--ops-surface-2": T.surface2,
    "--ops-inset": T.inset,
    "--ops-border": T.border,
    "--ops-border-soft": T.borderSoft,
    "--ops-text": T.text,
    "--ops-muted": T.textMuted,
    "--ops-faint": T.textFaint,
    "--ops-accent": T.accent,
    "--ops-accent-text": T.accentText,
    "--ops-accent-soft": T.accentSoft,
    "--ops-brand": T.brandAccent || T.accent,
    "--ops-pos": T.pos,
    "--ops-pos-soft": T.posSoft,
    "--ops-neg": T.neg,
    "--ops-neg-soft": T.negSoft,
    "--ops-chart": T.chartClv,
    "--ops-radius": `${T.radius}px`,
    "--ops-radius-md": `${T.radiusMd}px`,
    "--ops-radius-sm": `${T.radiusSm}px`,
    "--ops-display": T.font.display,
    "--ops-body": T.font.body,
    "--ops-num": T.font.num,
  };
}
