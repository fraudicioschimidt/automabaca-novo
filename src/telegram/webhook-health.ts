import type { Api } from "grammy";
import { createLogger } from "@/src/infra/logger";
import { sendOperationalAlert } from "@/src/services/ops/alerts";
import { resolveOperationalActionBySourceKey } from "@/src/services/ops/operational-actions";

const log = createLogger("telegram-webhook-health");

const CHECK_INTERVAL_MS = 5 * 60_000;
/** Erro de entrega mais novo que isto é problema de agora, não resto de um incidente passado. */
const RECENT_ERROR_MS = 15 * 60_000;
/** Fila pequena no Telegram é normal durante um deploy; crescendo acima disto, com erro, as entregas estão falhando. */
const PENDING_ALERT_THRESHOLD = 20;
const ALERT = { source: "telegram.webhook", key: "webhook-health" } as const;

type WebhookInfo = Awaited<ReturnType<Api["getWebhookInfo"]>>;

/** O que a checagem anterior viu: separa o erro novo do erro já contado. */
export type WebhookCheckState = { lastErrorDate: number | null; newErrorStreak: number; pending: number | null };
export const INITIAL_WEBHOOK_STATE: WebhookCheckState = { lastErrorDate: null, newErrorStreak: 0, pending: null };

/**
 * O webhook falha em silêncio do nosso lado: com o segredo divergente, o
 * Telegram toma 401 e só ele sabe. `getWebhookInfo` é o que ele diz das
 * entregas. Todo deploy reinicia o web e deixa um 502 isolado; só conta
 * erro que persiste (novo em duas checagens seguidas) ou que vem com a fila
 * crescendo, além do endereço trocado.
 */
export function evaluateWebhook(
  info: WebhookInfo,
  expected: { url: string; now: Date },
  previous: WebhookCheckState,
): { problem: string | null; state: WebhookCheckState } {
  const lastErrorDate = info.last_error_date ?? null;
  const recent = lastErrorDate !== null && expected.now.getTime() - lastErrorDate * 1000 <= RECENT_ERROR_MS;
  const newError = recent && lastErrorDate !== previous.lastErrorDate;
  const state = {
    lastErrorDate,
    newErrorStreak: newError ? previous.newErrorStreak + 1 : 0,
    pending: info.pending_update_count,
  };
  const pendingGrowing = previous.pending !== null &&
    info.pending_update_count >= PENDING_ALERT_THRESHOLD && info.pending_update_count > previous.pending;
  if (info.url !== expected.url) return { problem: `o Telegram entrega em outro endereço (${info.url || "nenhum"})`, state };
  if (recent && (state.newErrorStreak >= 2 || pendingGrowing)) {
    return {
      problem: `as entregas seguem falhando (${info.last_error_message ?? "sem detalhe"}; ${info.pending_update_count} updates esperando)`,
      state,
    };
  }
  return { problem: null, state };
}

/** Confere a cada ciclo se o Telegram ainda entrega no nosso webhook, a única entrada dos updates. */
export function startWebhookHealthCheck(api: Api, url: string): void {
  let state = INITIAL_WEBHOOK_STATE;
  const check = async () => {
    const info = await api.getWebhookInfo();
    const verdict = evaluateWebhook(info, { url, now: new Date() }, state);
    state = verdict.state;
    const problem = verdict.problem;
    if (!problem) {
      await resolveOperationalActionBySourceKey(ALERT.source, ALERT.key, "Entregas do webhook voltaram ao normal.");
      return;
    }
    await sendOperationalAlert(
      `🛑 O Telegram não está entregando os posts ao webhook\nMotivo: ${problem}.\n` +
        "👉 Confira o TELEGRAM_WEBHOOK_SECRET e o endereço do webhook; os posts esperam no Telegram por até 24 h.",
      {
        ...ALERT,
        title: "Webhook do Telegram falhando",
        resource: "telegram-bot",
        evidence: { pendingUpdates: info.pending_update_count, lastErrorDate: info.last_error_date ?? null },
        autoResolve: false,
      },
    );
  };
  const timer = setInterval(() => {
    check().catch((err) => log.warn({ err }, "verificação do webhook falhou; tenta de novo no próximo ciclo"));
  }, CHECK_INTERVAL_MS);
  timer.unref();
}
