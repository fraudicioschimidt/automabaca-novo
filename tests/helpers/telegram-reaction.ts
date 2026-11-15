import { handleChannelReaction as handle } from "@/src/services/capture/channel/reactions";
import type { ReactionEvent } from "@/src/domain/telegram-reaction";

let sequence = 0;
const metadata = new WeakMap<ReactionEvent, { occurredAt: string; updateId: number }>();
/** Fixtures antigas representam entregas identificadas; repetições do mesmo
 * objeto representam a mesma entrega original do Telegram. */
export function handleChannelReaction(event: ReactionEvent) {
  if (!metadata.has(event)) metadata.set(event, { occurredAt: "2026-09-13T01:00:00.000Z", updateId: ++sequence });
  return handle({ ...metadata.get(event), ...event });
}
