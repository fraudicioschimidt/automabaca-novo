/** Registro central de filas - adicionar aqui antes de usar. */
export const QUEUES = {
  healthHeartbeat: "health.heartbeat",
  closingSync: "closing.sync",
  closingSeries: "closing.price_series",
  closingSeriesSweep: "closing.price_series_sweep",
  /** Abertura e fechamento que faltam, na BridgeOdds, depois do jogo. */
  bridgePostgame: "sharp.bridge_postgame",
  /** Todo trabalho do Telegram, em ordem por post (`key_strict_fifo`). */
  telegramUpdates: "telegram.updates",
  /** Jobs com atraso intencional, como debounce de media_group. */
  telegramDeferred: "telegram.deferred",
  /** Enriquecimento sharp de uma aposta. */
  sharpEnrich: "sharp.enrich",
  /** Confirma a modalidade antes de liberar sharp e liquidação. */
  sportResolve: "capture.sport_resolve",
  /** Repescagem periódica de apostas que ainda precisam de identidade/preço. */
  sharpRevive: "sharp.revive",
  /** Avaliador da probation por segmento esporte x mercado. */
  policyEvaluate: "policy.evaluate",
  /** Conferência diária do dinheiro: saldo × ledger, lucro, ledger por aposta. */
  consistencyFinancial: "consistency.financeiro",
  /** Revisão diária: mercado fora do catálogo e escritas fora do fluxo. */
  consistencyReview: "consistency.revisao",
  /** Digest diário de PENDING com jogo já encerrado. */
  pendingDigest: "pending.digest",
  /** Fecha os casos de treino que não têm mais o que decidir: jogo antigo ou aposta removida. */
  trainingCasesCleanup: "training.close_stale_cases",
  healthDigest: "health.digest",
  /** Briefing executivo diário no Telegram com PnL, bancas e cotas. */
  executiveBriefing: "executive.briefing",
  /** Boletim semanal dos canais no Telegram: a régua de Bancas e quem mudou de veredito. */
  weeklyChannelDigest: "channels.weekly_digest",
  /** Fallback IA-Judge: grounded pode auto-liquidar; demais sugestões exigem homologação. */
  iaJudge: "settlement.ia_judge",
  /** Observação/fallback de resultados pelo FlashScore. */
  flashscoreResults: "settlement.flashscore_results",
  /** Reconfere o placar das apostas liquidadas por inferência (rede da dedução). */
  flashscoreRecheck: "settlement.flashscore_recheck",
  /** Resumo diário das liquidações por inferência — silencioso em dia vazio. */
  flashscoreInferenceReport: "settlement.flashscore_inference_report",
  /** Purge diário de AuditEvent. */
  auditPurge: "audit.purge",
  /** Despacha efeitos persistidos que sobreviveram a falha de pg-boss. */
  outboxDispatch: "outbox.dispatch",
  /** Avalia SLO de filas, providers e ações. */
  observabilitySlo: "observability.slo",
  /** Reconcilia a caixa prescritiva com o estado operacional atual. */
  operationalActions: "operational.actions",
  /** Canal calado além do próprio ritmo, e o bot que parou de receber. */
  telegramSilenceWatch: "telegram.silence_watch",
  /** Veredito de cada release: erro de fila nunca visto que apareceu junto com ela. */
  releaseVerdict: "ops.release_verdict",
  /** Liga os jogos de hoje da Pinnacle17 aos do FlashScore e grava as fichas dos times (só grava). */
  teamsCatalogPairing: "teams.catalog_pairing",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

const CONTRACT_QUEUES: ReadonlySet<string> = new Set(Object.values(QUEUES));

/**
 * Fila que esta versão registra e consome. Fila fora do contrato pode continuar
 * no banco (o pg-boss não apaga fila sozinho), mas nada a consome: mandar job
 * para ela é deixá-lo parado para sempre.
 */
export function isContractQueue(name: string): boolean {
  return CONTRACT_QUEUES.has(name);
}

export function deadLetterOf(queue: string): string {
  return `${queue}.dlq`;
}

/** Singleton key estável do enrich (mesma chave do enqueue). */
export function enrichSingletonKey(betId: string): string {
  return `bet:${betId}`;
}

/** Começo comum das chaves de resolução de esporte de uma aposta, qualquer tentativa. */
export function sportResolveKeyPrefix(betId: string): string {
  return `sport:${betId}:`;
}

export function sportResolveSingletonKey(betId: string, attempt: number): string {
  return `${sportResolveKeyPrefix(betId)}${attempt}`;
}

/**
 * Identidade lógica do trabalho que originou uma dead-letter. O requeue e o
 * replay usam a mesma chave para deduplicar contra a unidade original ainda
 * pendente ou ativa.
 */
export function recoverDlqSingletonKey(params: {
  name: string;
  data: unknown;
  metadataKey: string | null;
}): string | null {
  if (params.metadataKey) return params.metadataKey;
  if (
    params.name === QUEUES.sharpEnrich
    && params.data
    && typeof params.data === "object"
    && "betId" in params.data
    && typeof (params.data as { betId: unknown }).betId === "string"
  ) {
    return enrichSingletonKey((params.data as { betId: string }).betId);
  }
  return null;
}

export type QueueOptions = {
  retryLimit?: number;
  /** Segundos entre tentativas. */
  retryDelay?: number;
  /** Backoff exponencial (default true). Desligar para ritmo fixo. */
  retryBackoff?: boolean;
  /**
   * Teto da espera exponencial, em segundos. Sem ele o backoff dobra até o
   * último retry: base 60s com `retryLimit: 12` chega a ~68h na 12ª tentativa.
   * Só vale com `retryBackoff: true` (o pg-boss recusa a combinação inversa).
   */
  retryDelayMax?: number;
  /** Policy pg-boss; divergência falha o boot e exige migração operacional explícita. */
  policy?: "standard" | "short" | "singleton" | "stately" | "exclusive" | "key_strict_fifo";
  /** Sem sinal de vida do consumidor por este tempo, o pg-boss dá o job como perdido. */
  heartbeatSeconds?: number;
  /** Teto de execução de um job ativo. */
  expireInSeconds?: number;
  /** Por quanto tempo o pg-boss guarda o job concluído; ausente = padrão da fila. */
  deleteAfterSeconds?: number;
  /**
   * Fila disparada por cron: o maior intervalo entre dois disparos, em
   * minutos. A dead-letter dela não espera replay: sai (cron curto) ou volta
   * à fila com chave própria (cron longo).
   */
  cronMaxGapMinutes?: number;
  /** Tratamento extra quando um job esgota retries. */
  onDeadLetter?: (data: unknown) => Promise<void>;
};

/**
 * Policy canônica quando o caller omite. `sharp.enrich` e as de closing são
 * exclusive, `telegram.updates` é `key_strict_fifo`: sem isso um teste/boot
 * auxiliar que registra uma delas com o default `standard` deixa o índice único
 * ausente, e o boot real recusa a migração.
 */
export function defaultQueuePolicy(name: string): NonNullable<QueueOptions["policy"]> {
  if (name === QUEUES.telegramUpdates) return "key_strict_fifo";
  return name === QUEUES.sharpEnrich
    || name === QUEUES.closingSeries || name === QUEUES.closingSeriesSweep
    ? "exclusive"
    : "standard";
}
