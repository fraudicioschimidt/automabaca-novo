import Link from "next/link";
import React, { useState } from "react";
import { OpsCard } from "./ui-primitives";
import styles from "./channels-card.module.css";
import { ICONS, Icon } from "../../kit/icons";
import { toast } from "../../toast";
import type { MonitoramentoActions } from "../../action-contracts";
import type { MonitoramentoData } from "../../adapters/operacoes";

type Canal = MonitoramentoData["channels"][number];
type ResultadoDoRetry = Awaited<ReturnType<NonNullable<MonitoramentoActions["onRetryChannelTransient"]>>>;
type CaptureDiscarded = MonitoramentoActions["onCaptureDiscardedPost"];

function healthClass(value: number | null) {
  if (value == null) return styles.neutral;
  if (value >= 90) return styles.good;
  if (value < 80) return styles.bad;
  return styles.warn;
}

/**
 * Percentual que ainda não foi medido é travessão, não `null%`: "medi e deu
 * zero" e "não há o que medir" são leituras diferentes.
 */
export function percentual(valor: number | null | undefined) {
  return valor == null ? "—" : `${valor}%`;
}

function HealthMetric({ label, value, detail, pct }: { label: string; value: string; detail: string; pct: number | null }) {
  return <div className={styles.metric}><div className={styles.metricLabel}>{label}</div><div className={`${styles.metricValue} ${healthClass(pct)}`}>{value}</div><div className={styles.metricDetail}>{detail}</div></div>;
}

/**
 * As causas de parse vêm prontas de `domain/recusa-de-captura` (rótulo em
 * PT-BR, classe e próxima etapa), com os mesmos nomes do funil.
 */
export function causasDeParse(channel: { parsePerdas: Readonly<Canal["parsePerdas"]> }) {
  return (channel.parsePerdas || []).map((perda) => `${perda.rotulo} (${perda.n})`).join(' · ');
}

export function transientRetryLabel(channel: Pick<Canal, "transientFailures" | "transientBatchLimit">) {
  const batchSize = Math.min(channel.transientFailures, channel.transientBatchLimit);
  return `Reprocessar até ${batchSize} de ${channel.transientFailures}`;
}

export function transientRetryFeedback(result: ResultadoDoRetry) {
  const parts = [
    `${result.enfileiradas} falha${result.enfileiradas === 1 ? '' : 's'} transitória${result.enfileiradas === 1 ? '' : 's'} reenfileirada${result.enfileiradas === 1 ? '' : 's'}`,
  ];
  if (result.puladas > 0) {
    parts.push(`${result.puladas} já ${result.puladas === 1 ? 'estava' : 'estavam'} na fila`);
  }
  const foraDoLote = Math.max(0, result.totalElegiveis - result.elegiveis);
  if (foraDoLote > 0) {
    parts.push(`${foraDoLote} ${foraDoLote === 1 ? 'ficou' : 'ficaram'} fora deste lote`);
  }
  return parts.join(' · ');
}

/**
 * Posts de texto que o filtro anti-ruído barrou. O operador lê o texto e, se
 * era aposta, pede a captura: o post volta à leitura no worker sem o filtro.
 */
function DiscardedPosts({ channel, onCapture }: { channel: Canal; onCapture?: CaptureDiscarded }) {
  const [pending, setPending] = useState(() => new Set<number>());
  const [requested, setRequested] = useState(() => new Set<number>());
  if (channel.discardedTotal === 0) return null;

  const capture = async (messageId: number) => {
    if (!onCapture || pending.has(messageId)) return;
    setPending((prev) => new Set(prev).add(messageId));
    try {
      const { status } = await onCapture(channel.tg, messageId);
      setRequested((prev) => new Set(prev).add(messageId));
      toast(status === 'ja_na_fila' ? 'Este post já está na fila de captura' : 'Captura pedida: o post volta para a leitura', 'ok');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Falha ao pedir a captura', 'warn');
    } finally {
      setPending((prev) => { const next = new Set(prev); next.delete(messageId); return next; });
    }
  };

  const plural = channel.discardedTotal === 1 ? '' : 's';
  return (
    <details className={styles.discarded}>
      <summary className={styles.discardedSummary}>{channel.discardedTotal} post{plural} que não {channel.discardedTotal === 1 ? 'virou' : 'viraram'} aposta</summary>
      {channel.discardedTotal > channel.discarded.length ? <div className={styles.small}>Exibindo os {channel.discarded.length} mais recentes.</div> : null}
      {channel.discarded.map((post) => {
        const asked = requested.has(post.messageId) || post.captureRequestedAt !== null;
        return (
          <div key={post.messageId} className={styles.discardedRow}>
            <div className={styles.flex}>
              <div className={styles.small}>{post.photo ? 'Foto' : 'Post'} {post.messageId} · {post.postedAt} ({post.age}) · {post.reason}{post.captureRequestedAt ? ` · captura pedida em ${post.captureRequestedAt}` : ''}{post.link ? <> · <a href={post.link} target="_blank" rel="noreferrer" className={styles.postLink}>abrir no Telegram</a></> : null}</div>
              <p className={styles.discardedText}>{post.text}</p>
              {post.stale ? <div className={styles.staleWarning}>Postado há mais de 3 h: o jogo pode ter terminado. Confira antes de capturar.</div> : null}
            </div>
            {onCapture ? <button type="button" disabled={pending.has(post.messageId)} onClick={() => capture(post.messageId)} className={styles.retry}>{pending.has(post.messageId) ? 'Pedindo…' : asked ? 'Pedir de novo' : 'Capturar mesmo assim'}</button> : null}
          </div>
        );
      })}
    </details>
  );
}

export function ChannelsCard({ channels, orphanChannels = [], orphanChannelsTotal = null, onRetryTransient, onCaptureDiscarded }: {
  channels: Canal[];
  orphanChannels?: MonitoramentoData["orphanChannels"];
  orphanChannelsTotal?: number | null;
  onRetryTransient?: MonitoramentoActions["onRetryChannelTransient"];
  onCaptureDiscarded?: CaptureDiscarded;
}) {
  const [processing, setProcessing] = useState(() => new Set<string>());
  const orphans = orphanChannels.length > 0 ? orphanChannels : channels.filter((c) => c.orphan);
  const orphanTotal = Math.max(orphans.length, orphanChannelsTotal ?? orphans.length);
  const mapped = channels.filter((c) => !c.orphan);

  const retry = async (channel: Canal) => {
    if (!onRetryTransient || processing.has(channel.id)) return;
    setProcessing((prev) => new Set(prev).add(channel.id));
    try {
      const result = await onRetryTransient(channel.tg);
      toast(transientRetryFeedback(result), 'ok');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Falha ao reprocessar canal', 'warn');
    } finally {
      setProcessing((prev) => { const next = new Set(prev); next.delete(channel.id); return next; });
    }
  };

  return (
    <OpsCard pad={0} className={styles.card}>
      <div className={styles.header}><div><h3 className={styles.title}>Saúde dos canais</h3><div className={styles.subtitle}>Parse e resolução · 30 dias; capturas, identidade e odds · histórico</div></div><span className={styles.window}>pré-kickoff em 24 h</span></div>
      {orphans.length > 0 ? (
        <div className={styles.orphanWrap}><div className={styles.orphanBox}>
          <div className={styles.orphanTitle}>{orphanTotal} {orphanTotal === 1 ? 'canal' : 'canais'} sem tipster mapeado</div>
          {orphanTotal > orphans.length ? <div className={styles.small}>Exibindo os {orphans.length} mais recentes.</div> : null}
          {orphans.map((c) => <div key={c.id} className={styles.orphanRow}><div className={styles.flex}><div className={styles.mono}>{c.tg}</div><div className={styles.small}>{c.captures} post(s) · última {c.last}</div></div><Link href="/config" className={styles.link}>Mapear em Config</Link></div>)}
        </div></div>
      ) : null}
      {mapped.map((c) => {
        const busy = processing.has(c.id);
        const noOdds = (c.noOdds || []).map((item) => `${item.label} (${item.n})`).join(' · ');
        const parseFailures = causasDeParse(c);
        const descartadas = c.parseDescartadas > 0
          ? `${c.parseDescartadas} não era${c.parseDescartadas === 1 ? '' : 'm'} aposta (fora da conta)`
          : '';
        return (
          <article key={c.id} className={styles.channel}>
            <div className={styles.channelHead}><div className={styles.icon}><Icon d={ICONS.tg} s={18} /></div><div className={styles.flex}><div className={styles.channelName}>{c.name}</div><div className={`${styles.small} ${styles.mono}`}>{c.tg} · {c.captures} capturas · última {c.last} · último update {c.lastUpdate ?? 'nenhum registrado'}</div></div>{c.silence ? <span className={c.silence.kind === 'mudo' ? styles.silent : styles.learning} title={c.silence.detail}>{c.silence.kind}</span> : null}{c.preKickoffFailures > 0 ? <span className={styles.preKickoff}>{c.preKickoffFailures} pré-kickoff</span> : null}</div>
            {c.silence?.kind === 'mudo' ? <div className={styles.silentDetail}>Canal {c.silence.detail}.</div> : null}
            <div className={styles.metrics}>
              <HealthMetric label="Parse" value={percentual(c.parse)} detail={c.parse == null ? 'nenhum post lido na janela' : `${c.ok}/${c.total} posts que eram aposta`} pct={c.parse} />
              <HealthMetric label="Identidade" value={percentual(c.identity)} detail={`${c.identityResolved} ok · ${c.identityPending} pend.`} pct={c.identity} />
              <HealthMetric label="Resolução p50" value={c.resolutionP50} detail={`p95 ${c.resolutionP95} · n=${c.resolutionSamples}`} pct={null} />
              <HealthMetric label="Post → captura p50" value={c.latencyP50} detail={`p95 ${c.latencyP95} · n=${c.latencySamples}`} pct={null} />
            </div>
            <div className={styles.footer}><div className={styles.causes}>{parseFailures ? <div><b>Causas de parse:</b> {parseFailures}</div> : null}{descartadas ? <div className={styles.small}>{descartadas}</div> : null}{noOdds ? <div><b>Sem odds:</b> {noOdds}</div> : null}{!parseFailures && !noOdds ? 'Sem causas recorrentes registradas nesta janela.' : null}</div>
              {c.transientFailures > 0 && onRetryTransient ? <div className={styles.retryGroup}><button type="button" disabled={busy} onClick={() => retry(c)} className={styles.retry}>{busy ? 'Reenfileirando…' : transientRetryLabel(c)}</button><span className={styles.retryNote}>apostas já na fila não são duplicadas</span></div> : null}</div>
            <DiscardedPosts channel={c} onCapture={onCaptureDiscarded ?? undefined} />
          </article>
        );
      })}
    </OpsCard>
  );
}
