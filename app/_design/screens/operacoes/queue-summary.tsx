import styles from "./operacoes.module.css";
import type { useOperacoesState } from "./use-operacoes-state";

/**
 * As filas de Operações: cada cartão de resumo (rótulo, número e o que ele
 * conta) é também a aba da fila. O da fila aberta fica branco e levantado, com
 * o filete dourado; os outros, translúcidos sobre a página.
 */
export function QueueTabs({ filas, ativa, onSelecionar }: {
  filas: ReturnType<typeof useOperacoesState>["filas"];
  ativa: string;
  onSelecionar: (id: string) => void;
}) {
  return (
    <div className={styles.queueTabs} role="tablist" aria-label="Filas de trabalho">
      {filas.map((fila) => {
        const selecionada = fila.id === ativa;
        return (
          <button
            key={fila.id}
            type="button"
            role="tab"
            id={`segmento-tab-${fila.id}`}
            aria-selected={selecionada}
            aria-controls={`segmento-painel-${fila.id}`}
            tabIndex={selecionada ? 0 : -1}
            onClick={() => onSelecionar(fila.id)}
            className={`${styles.queueTab} ${selecionada ? styles.queueTabAtiva : ""}`}
          >
            <span className={styles.queueTabCap}>{fila.cap}</span>
            {/* Zero é BOA notícia numa fila de trabalho: verde, não cinza. */}
            <span className={`${styles.queueTabNum} ${fila.n === 0 ? styles.queueTabNumZero : ""}`}>{fila.n}</span>
            <span className={styles.queueTabNota}>{fila.nota}</span>
          </button>
        );
      })}
    </div>
  );
}
