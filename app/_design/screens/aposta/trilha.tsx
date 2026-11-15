"use client";

import { formatSpTime, spDayKey } from "@/src/domain/dates";
import type { LinhaDaTrilha, TrilhaDaAposta as Trilha } from "@/src/services/painel/aposta/trilha";
import { useDesign } from "../../kit/context";
import { contagem } from "../../lib/plural";
import styles from "./trilha.module.css";
import type { CssVarsStyle } from "../../kit/css-vars";

/**
 * O histórico da aposta: tudo que o sistema decidiu sobre ela, em prosa. A
 * frase é uniforme (`domain/trilha-da-aposta`) e o negrito marca só a parte
 * variável, para o olho pousar no que difere. O diff de uma edição vem fora da
 * frase, uma linha `campo: de → para` por mudança.
 */
export function TrilhaDaAposta({ trilha }: { trilha: Trilha | null }) {
  const { T, numFont } = useDesign();
  if (!trilha) return null;
  const { linhas, completa, comecaEm, retencaoDias } = trilha;

  const vars: CssVarsStyle = {
    "--tr-border-soft": T.borderSoft,
    "--tr-text": T.text,
    "--tr-muted": T.textMuted,
    "--tr-faint": T.textFaint,
    "--tr-neg": T.neg,
    "--tr-surface-2": T.surface2,
    "--tr-radius-sm": `${T.radiusSm}px`,
    "--tr-font-body": T.font.body,
    "--tr-font-display": T.font.display,
    "--tr-display-size": "17px",
    "--tr-display-weight": 600,
  };

  if (linhas.length === 0) {
    return (
      <section className={styles.trilha} style={vars}>
        <h3 className={styles.titulo}>Histórico</h3>
        {/* O serviço só devolve lista vazia quando não há evento, nunca quando falhou a leitura. */}
        <p className={styles.vazio}>
          Nenhum evento registrado para esta aposta.
        </p>
      </section>
    );
  }

  const dias = agruparPorDia(linhas);

  return (
    <section id="historico-da-aposta" className={styles.trilha} style={vars}>
      <h3 className={styles.titulo}>Histórico</h3>
      <p className={styles.sub}>Tudo que o sistema decidiu sobre esta aposta, do mais recente.</p>

      {dias.map(([dia, doDia]) => (
        <div key={dia} className={styles.dia}>
          <div className={styles.diaRotulo}>{rotuloDoDia(dia)}</div>
          <ol className={styles.lista}>
            {doDia.map((l) => (
              <li key={l.id} className={styles.linha}>
                <time className={styles.hora} style={numFont} dateTime={l.em}>
                  {formatSpTime(new Date(l.em))}
                </time>
                <div className={styles.corpo}>
                  <p className={styles.frase}>
                    {l.frase.map((t, i) => (
                      t.forte
                        ? <strong key={i} className={styles.forte}>{t.texto}</strong>
                        : <span key={i}>{t.texto}</span>
                    ))}
                    {!l.ok && <span className={styles.falhou}> · não concluiu</span>}
                  </p>
                  {l.mudancas.length > 0 && (
                    <ul className={styles.mudancas}>
                      {l.mudancas.map((m) => (
                        <li key={m.campo} className={styles.mudanca}>
                          <span className={styles.campo}>{m.campo}</span>
                          <span className={styles.de} style={numFont}>{m.de}</span>
                          <span className={styles.seta} aria-label="virou">→</span>
                          <span className={styles.para} style={numFont}>{m.para}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      ))}

      {/* A trilha declara o próprio alcance: lista curta sem esta linha parece aposta sem história. */}
      {!completa && comecaEm && (
        <p className={styles.horizonte}>
          A trilha começa em <b style={numFont}>{spDayKeyBr(comecaEm)}</b> — o registro anterior
          não existe mais. Eventos são guardados por {contagem(retencaoDias, "dia")}.
        </p>
      )}
    </section>
  );
}

/** Agrupa mantendo a ordem que veio (mais novo primeiro). */
function agruparPorDia(linhas: readonly LinhaDaTrilha[]): Array<[string, LinhaDaTrilha[]]> {
  const mapa = new Map<string, LinhaDaTrilha[]>();
  for (const l of linhas) {
    const dia = spDayKey(new Date(l.em));
    const lista = mapa.get(dia);
    if (lista) lista.push(l);
    else mapa.set(dia, [l]);
  }
  return [...mapa.entries()];
}

/** "2026-08-12" → "12/08/2026". */
function diaBr(dayKey: string): string {
  const [ano, mes, dia] = dayKey.split("-");
  return `${dia}/${mes}/${ano}`;
}

function spDayKeyBr(iso: string): string {
  return diaBr(spDayKey(new Date(iso)));
}

function rotuloDoDia(dayKey: string): string {
  const hoje = spDayKey(new Date());
  if (dayKey === hoje) return `Hoje · ${diaBr(dayKey)}`;
  return diaBr(dayKey);
}
