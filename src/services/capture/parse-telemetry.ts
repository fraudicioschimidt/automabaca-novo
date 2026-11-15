import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import type { CaptureOcrEvidence } from "@/src/domain/capture-ocr-evidence";
import type { Prisma } from "@/src/generated/prisma/client";

const log = createLogger("parse-telemetry");

export type ParseFailureClass =
  | "transient_provider"
  | "content_incomplete"
  | "guard_rejected"
  | "not_a_bet";

export function classifyParseFailure(
  outcome: "registered" | "duplicate" | "unparseable" | "guard_rejected",
  reason?: string,
): { failureClass: ParseFailureClass; retryable: boolean } | null {
  if (outcome === "registered" || outcome === "duplicate") return null;
  if (reason === "llm_exhausted") return { failureClass: "transient_provider", retryable: true };
  if (reason === "not_bet") return { failureClass: "not_a_bet", retryable: false };
  if (outcome === "guard_rejected") return { failureClass: "guard_rejected", retryable: false };
  return { failureClass: "content_incomplete", retryable: false };
}

/**
 * Telemetria de qualidade do parser de canal: cada post que parecia aposta vira
 * um AuditEvent `telegram.parse`, agregado no card "Canais Telegram" de
 * Operações. Best-effort: a falha não derruba a captura, mas vai para o log.
 */
export async function recordParseTelemetry(
  post: { chatId: bigint; messageId: number },
  outcome: "registered" | "duplicate" | "unparseable" | "guard_rejected",
  details: {
    via: string; missing?: string[]; reason?: string; ocrEvidence?: CaptureOcrEvidence;
    /** Apostas do post recusado inteiro por um item (lote): o funil separa o lote da aposta avulsa. */
    items?: number;
  },
): Promise<void> {
  try {
    const failure = classifyParseFailure(outcome, details.reason);
    // O mesmo update passa novamente pelo handler a cada tentativa da fila.
    // Uma falha transitória é uma propriedade do POST, não de cada retry: sem
    // esta guarda, 1 post com 3 retries viraria 4 falhas no painel de captura.
    if (failure?.retryable) {
      const alreadyRecorded = await prisma.auditEvent.findFirst({
        where: {
          action: "telegram.parse",
          resource: String(post.chatId),
          resourceId: String(post.messageId),
          outcome,
          details: { path: ["reason"], equals: details.reason },
        },
        select: { id: true },
      });
      if (alreadyRecorded) return;
    }
    await prisma.auditEvent.create({
      data: {
        actor: "telegram-channel",
        action: "telegram.parse",
        resource: String(post.chatId),
        resourceId: String(post.messageId),
        outcome,
        details: JSON.parse(JSON.stringify(failure ? { ...details, ...failure } : details)) as Prisma.InputJsonObject,
      },
    });
  } catch (err) {
    log.error({ err, messageId: post.messageId }, "falha ao gravar telemetria de parse");
  }
}
