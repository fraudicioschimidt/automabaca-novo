import styles from "./operacoes.module.css";

/**
 * O total de pendências fica ao lado do título e o estado vira uma frase do
 * subtítulo. Sem leitura do banco as filas chegam vazias, e a contagem zero não
 * pode virar "Tudo em dia": o título fica sem número e a frase diz que não
 * houve leitura.
 */
export function OperacoesHeader({ actionCount, available }: { actionCount: number; available: boolean }) {
  const allClear = available && actionCount === 0;
  const status = !available
    ? <span className={styles.statusBad}>Leitura indisponível: o banco não respondeu.</span>
    : allClear
      ? <span className={styles.statusOk}>Tudo em dia.</span>
      : <span className={styles.statusPending}>{actionCount} esperando você.</span>;
  return (
    <div className={styles.pageHeader}>
      <div>
        <h1 className={styles.pageTitle}>
          Operações
          {available ? <span className={allClear ? styles.titleCount : styles.titleCountPending}>{actionCount}</span> : null}
        </h1>
        <div className={styles.pageSubtitle}>
          Decisões e exceções que precisam da sua ação. {status}
        </div>
      </div>
    </div>
  );
}
