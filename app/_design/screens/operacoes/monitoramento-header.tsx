import styles from "./operacoes.module.css";
import { contagem } from "../../lib/plural";
import { motivosDeAtencao, type MotivoDeAtencao } from "@/src/domain/motivos-de-atencao";
import type { MonitoramentoSummary } from "@/src/domain/monitoramento-health";

/**
 * Cabeçalho do Monitoramento, em módulo próprio para `/operacoes` não levar
 * no bundle os rótulos de atenção que nunca renderiza.
 */
/**
 * O rótulo de cada motivo que o domínio sabe emitir. Chave sem rótulo aqui é
 * um "Atenção necessária" mudo: o `switch` sem o caso não compila, e o teste
 * reprova.
 */
function rotuloDeAtencao(motivo: MotivoDeAtencao): string {
  switch (motivo.chave) {
    case 'motor': return 'motor degradado';
    case 'jobs': return 'jobs sem leitura ou com falha';
    case 'slo': return contagem(motivo.n, 'SLO violado', 'SLOs violados');
    case 'canais': return motivo.n == null ? 'canais sem leitura' : contagem(motivo.n, 'canal degradado', 'canais degradados');
    case 'acoes': return contagem(motivo.n, 'ação na fila', 'ações na fila');
  }
}

export function textoDeAtencao(summary: MonitoramentoSummary | null | undefined) {
  // Sem resumo não há leitura, e sem leitura não há motivo a listar.
  const motivos = summary ? motivosDeAtencao(summary) : [];
  if (motivos.length === 0) return null;
  return motivos.map(rotuloDeAtencao).join(' · ');
}

export function MonitoramentoHeader({ summary }: { summary: MonitoramentoSummary | null | undefined }) {
  const state = summary?.state ?? "unavailable";
  const healthy = state === "healthy";
  // O número do título conta os problemas; sem leitura não há o que contar.
  const problemas = summary && state !== "unavailable" ? motivosDeAtencao(summary).length : null;
  const motivo = healthy ? null : textoDeAtencao(summary);
  // O veredito sozinho não diz o que fazer: quem decide a cor já sabe a causa,
  // e ela vem junto.
  const status = state === 'unavailable'
    ? <span className={styles.statusBad}>Leitura indisponível.</span>
    : healthy
      ? <span className={styles.statusOk}>Saúde consistente.</span>
      : <><span className={styles.statusBad}>Atenção necessária{motivo ? ':' : '.'}</span>{motivo ? ` ${motivo}.` : null}</>;
  return (
    <div className={styles.pageHeader}>
      <div>
        <h1 className={styles.pageTitle}>
          Monitoramento
          {problemas != null ? <span className={problemas ? styles.titleCountAlert : styles.titleCount}>{problemas}</span> : null}
        </h1>
        <div className={styles.pageSubtitle}>
          Saúde do motor, filas, providers e canais em um só lugar. {status}
        </div>
      </div>
    </div>
  );
}
