import { constantTimeEqual } from "@/src/infra/auth";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getEnv } from "@/src/infra/env";
import { getSharedBoss } from "@/src/infra/boss";
import { observedRoute } from "@/src/services/ops/http-telemetry";
import { enqueueTelegramJob } from "@/src/services/scheduling/enqueue-telegram-job";
import { readTextBodyWithin } from "@/src/infra/http-request";
import { createLogger } from "@/src/infra/logger";
import { recordChannelActivityInBackground } from "@/src/services/capture/channel/channel-activity";

const MAX_WEBHOOK_BYTES = 256 * 1024;
const log = createLogger("telegram-webhook");
// Só o `update_id` é exigido: tipo de update que o Telegram criar depois
// segue para a fila em vez de ser descartado aqui.
const updateSchema = z.looseObject({ update_id: z.number().int().nonnegative() })
  .refine((update) => Object.keys(update).length > 1, "Update sem payload");

async function handlePost(request: NextRequest): Promise<NextResponse> {
  const expected = getEnv().TELEGRAM_WEBHOOK_SECRET;
  const received = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!expected || !received || !constantTimeEqual(received, expected)) {
    return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  }

  const body = await readTextBodyWithin(request, MAX_WEBHOOK_BYTES);
  if (!body.ok && body.reason === "too_large") {
    return NextResponse.json({ error: "Payload grande demais." }, { status: 413 });
  }
  if (!body.ok) {
    log.warn({ reason: body.reason }, "update autenticado inválido ignorado");
    return NextResponse.json({ ok: true, ignored: true });
  }
  let parsedJson: unknown;
  try { parsedJson = JSON.parse(body.value); } catch { parsedJson = null; }
  const parsed = updateSchema.safeParse(parsedJson);
  if (!parsed.success) {
    log.warn({ reason: "invalid_update" }, "update autenticado inválido ignorado");
    // O Telegram repete qualquer entrega que não receba 2xx. Depois de validar
    // o segredo, payload inválido não deve entrar num loop de retry sem saída.
    return NextResponse.json({ ok: true, ignored: true });
  }

  // Direto na fila ordenada do post; a reentrega do mesmo update_id cai no id
  // determinístico e volta como duplicada.
  const jobId = await enqueueTelegramJob(await getSharedBoss(), { kind: "telegram_update", update: parsed.data });
  if (!jobId) return NextResponse.json({ ok: true, duplicate: true });
  recordChannelActivityInBackground(parsed.data);
  return NextResponse.json({ ok: true });
}

// Segredo divergente responde 401 a todo update do Telegram: é falha, não sucesso.
export const POST = observedRoute("/api/telegram/webhook", handlePost, { failureStatuses: [401, 403] });
