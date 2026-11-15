"use client";

import { useDesign } from "./context";
import { formaDoContador, legendaDoSegmento, type Segmento } from "../lib/segmentos-de-secao";
import styles from "./segment-nav.module.css";
import type { CssVarsStyle } from "./css-vars";

/**
 * Navegação das seções de Operações, Monitoramento e Config em cartões: o nome
 * em cima e, embaixo, o estado da seção ("10 abertos", "em dia") ou o que ela
 * mostra. `segmentos` é o descritor estático (`lib/segmentos-de-secao`), que
 * fixa o significado de cada contador; `contagens` é o mapa `id → número` do
 * momento.
 */
export function SegmentNav({
  segmentos,
  contagens,
  ativo,
  onSelecionar,
  rotulo = "Seções",
}: {
  segmentos: readonly Segmento[];
  contagens?: Readonly<Record<string, number | null | undefined>> | null;
  ativo: string;
  onSelecionar: (id: string) => void;
  rotulo?: string;
}) {
  const { T, mode } = useDesign();

  const vars: CssVarsStyle = {
    "--sn-border": T.border,
    "--sn-border-soft": T.borderSoft,
    "--sn-surface": T.surface,
    "--sn-brand": T.brandAccent || T.accent,
    "--sn-lift": mode === "dark"
      ? "0 1px 0 rgba(255,255,255,.04), 0 6px 14px -8px rgba(0,0,0,.8)"
      : "0 1px 2px rgba(20,18,14,.08), 0 4px 12px -6px rgba(20,18,14,.18)",
    "--sn-text": T.text,
    "--sn-muted": T.textMuted,
    "--sn-faint": T.textFaint,
    "--sn-accent": T.accent,
    "--sn-accent-soft": T.accentSoft,
    "--sn-pos": T.pos,
    "--sn-body": T.font.body,
    "--sn-num": T.font.num,
  };

  return (
    <div className={styles.nav} style={vars} role="tablist" aria-label={rotulo}>
      {segmentos.map((s) => {
        const selecionado = s.id === ativo;
        const forma = formaDoContador(s.tipo, contagens?.[s.id]);
        return (
          <button
            key={s.id}
            type="button"
            role="tab"
            id={`segmento-tab-${s.id}`}
            aria-selected={selecionado}
            aria-controls={`segmento-painel-${s.id}`}
            tabIndex={selecionado ? 0 : -1}
            onClick={() => onSelecionar(s.id)}
            className={`${styles.tab} ${selecionado ? styles.tabAtiva : ""}`}
          >
            <span className={styles.rotulo}>{s.rotulo}</span>
            <span
              className={`${styles.legenda} ${
                forma === "atencao" ? styles.legendaAtencao : forma === "resolvido" ? styles.legendaResolvido : ""
              }`}
            >
              {legendaDoSegmento(s, contagens?.[s.id])}
            </span>
          </button>
        );
      })}
    </div>
  );
}
