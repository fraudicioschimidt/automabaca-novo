import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { BetRowData } from "@/src/domain/bet-read-model";
import { formatSpDateTime, formatSpDateWithYear } from "@/src/domain/dates";
import { splitEvento } from "../../adapters/_evento";
import { fmtOdds } from "@/src/domain/formato-de-resultado";
import { useDesign } from "../../kit/context";
import { contagem } from "../../lib/plural";
import { rotuloDeStatus } from "@/src/domain/status-de-aposta";
import styles from "./gaveta-de-apostas.module.css";
import type { CssVarsStyle } from "../../kit/css-vars";
import type { RecorteDeApostas } from "./use-analise-do-recorte";
import { useMoneyFormat } from "./ui-primitives";

/**
 * As apostas por trás de um número do Analyzer.
 *
 * `apostas` é o array que `agregaGrupo` agregou (`membros`), não um filtro
 * reconstruído aqui: por isso o `resumo` pode repetir os números da linha
 * clicada, e uma divergência apareceria na cara.
 *
 * Só leitura: o payload do Analyzer não traz o que liquidar/apagar exige, e quem
 * quer agir clica na aposta e vai para a ficha. Cor de resultado usa `T.pos`/
 * `T.neg` (AA para texto de 13.5px), não as variantes `Display`.
 */
export function GavetaDeApostas({ apostas, resumo }: {
  apostas: readonly BetRowData[];
  resumo: RecorteDeApostas["resumo"] | null;
}) {
  const { T, numFont } = useDesign();
  const listRef = useRef<HTMLDivElement>(null);
  const sorted = useMemo(() => [...apostas].sort((a, b) => b.data.getTime() - a.data.getTime()), [apostas]);
  const [pagination, setPagination] = useState({ source: apostas, page: 1 });
  const pages = Math.max(1, Math.ceil(sorted.length / 50));
  const page = pagination.source === apostas ? Math.min(pagination.page, pages) : 1;
  const shown = sorted.slice((page - 1) * 50, page * 50);
  const changePage = (next: number) => {
    setPagination({ source: apostas, page: next });
    if (listRef.current) listRef.current.scrollTop = 0;
  };

  const money = useMoneyFormat();
  const vars: CssVarsStyle = {
    '--gv-font': T.font.body,
    '--gv-text': T.text,
    '--gv-muted': T.textMuted,
    '--gv-faint': T.textFaint,
    '--gv-accent': T.accent,
    '--gv-border': T.borderSoft,
    '--gv-radius': `${T.radiusSm}px`,
    '--gv-inset': T.surface2,
    '--gv-hover': T.surface2,
    '--gv-pos': T.pos,
    '--gv-neg': T.neg,
    '--gv-fast': T.motion.fast,
  };

  if (!apostas.length) {
    return <div className={`${styles.raiz} ${styles.vazio}`} style={vars}>Nenhuma aposta neste recorte.</div>;
  }

  // Mais recentes primeiro, como o histórico lê. `data` é o kickoff (UTC no
  // banco); a exibição passa pelo SSOT de datas, nunca por conversão ad-hoc.


  return (
    <div className={styles.raiz} style={vars}>
      {resumo ? (
        <div className={styles.resumo}>
          {resumo.map((item) => (
            <div key={item.k} className={styles.resumoItem}>
              <span className={styles.resumoRotulo}>{item.k}</span>
              <span className={`${styles.resumoValor} ${styles[item.tom || 'neutro']}`} style={numFont}>{item.v}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div
        ref={listRef}
        className={`${styles.lista} no-scrollbar`}
        role="region"
        aria-label={`Apostas do recorte — ${contagem(sorted.length, 'aposta')}`}
        tabIndex={0}
      >
        {shown.map((b) => {
          const { home, away } = splitEvento(b.evento);
          const status = rotuloDeStatus(b.status);
          const resolvida = status !== 'pendente' && b.lucro != null;
          const tom = !resolvida ? 'neutro' : b.lucro > 0 ? 'pos' : b.lucro < 0 ? 'neg' : 'neutro';
          return (
            <Link key={b.id} href={`/aposta?id=${encodeURIComponent(b.id)}`} prefetch={false} className={styles.linha}>
              <span className={styles.principal}>
                <span className={styles.evento}>
                  {home}{away ? <><span className={styles.versus}> vs </span>{away}</> : null}
                </span>
                <span className={styles.meta}>
                  <span className={styles.mercado}>{b.mercado}</span>
                  {b.selecao ? ` ${b.selecao}` : ''}
                  <span className={styles.ponto}>·</span>
                  <span style={numFont}>{fmtOdds(b.odds)}</span>
                  <span className={styles.ponto}>·</span>
                  <span style={numFont}>
                    {b.kickoffInferido ? `${formatSpDateWithYear(b.data)} · horário a confirmar` : formatSpDateTime(b.data)}
                  </span>
                  {b.casaDeAposta ? <><span className={styles.ponto}>·</span>{b.casaDeAposta}</> : null}
                  {/* Na carteira, de qual banca a aposta veio. */}
                  {b.bankrollName ? <><span className={styles.ponto}>·</span>{b.bankrollName}</> : null}
                </span>
              </span>
              <span className={styles.resultado}>
                <span className={`${styles.valor} ${styles[tom]}`} style={numFont}>
                  {resolvida ? money.signed(b.lucro) : money.amount(b.stake)}
                </span>
                <span className={styles.status}>{status}</span>
              </span>
            </Link>
          );
        })}
      </div>
      {pages > 1 && <nav className={styles.pagination} aria-label="Páginas das apostas do recorte">
        <button type="button" disabled={page === 1} onClick={() => changePage(page - 1)}>Anterior</button>
        <span aria-live="polite">Página {page} de {pages} · {contagem(sorted.length, 'aposta')}</span>
        <button type="button" disabled={page === pages} onClick={() => changePage(page + 1)}>Próxima</button>
      </nav>}
    </div>
  );
}
