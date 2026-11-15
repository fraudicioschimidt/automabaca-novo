import { fmtPct } from "@/src/domain/formato-de-resultado";
import type { AnalyzerQuery } from "@/src/domain/analyzer-query";
import type { getAnalyzerData } from "../../adapters/analyzer";
import { unpackAnalyzerBets } from "../../lib/analyzer-pack";
import { GavetaDeApostas } from "./gaveta-de-apostas";
import { contagem } from "../../lib/plural";
import styles from "./server-controls.module.css";
import { useMoneyFormat } from "./ui-primitives";
type ChangeQuery = (change: Partial<AnalyzerQuery>) => void;

export function AnalyzerLargeHistory({ history, onChange, pending }: {
  history: NonNullable<NonNullable<Awaited<ReturnType<typeof getAnalyzerData>>>["largeHistory"]>;
  onChange: ChangeQuery; pending: boolean;
}) {
  const money = useMoneyFormat();
  return <section className={styles.history} aria-busy={pending}>
    <h2>Resumo do período completo</h2>
    <p>Este recorte tem um histórico extenso. Os totais incluem todas as apostas do período, pelo dia do jogo, e as pendentes de jogos futuros; a lista está paginada. Selecione um período menor para abrir gráficos e comparativos detalhados.</p>
    <dl className={styles.metrics}>
      {[["Apostas", String(history.total)], ["Liquidadas com resultado", String(history.resolved)], ["Pendentes", String(history.pending)],
        ["Lucro", money.signed(history.profit)], ["Stake liquidada", money.amount(history.stake)], ["ROI", fmtPct(history.roi)]].map(([label, value]) =>
        <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
    <GavetaDeApostas apostas={unpackAnalyzerBets(history.rows)} resumo={null} />
    <nav className={styles.pagination} aria-label="Páginas do histórico">
      <button disabled={pending || history.page <= 1} onClick={() => onChange({ pagina: history.page - 1 })}>Anterior</button>
      <span aria-live="polite">Página {history.page} de {history.pages} · {contagem(history.total, "aposta")}</span>
      <button disabled={pending || history.page >= history.pages} onClick={() => onChange({ pagina: history.page + 1 })}>Próxima</button>
    </nav>
  </section>;
}
