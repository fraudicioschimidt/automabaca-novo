import { describe, expect, it } from "vitest";
import {
  InvalidTelegramJobError,
  parseTelegramJob,
  routeTelegramJob,
  type TelegramJob,
} from "@/src/domain/telegram-job";

const POST_DATE = "2026-09-20T12:00:00.000Z";
const EDIT_DATE = "2026-09-20T12:05:00.000Z";

function update(body: Record<string, unknown>, updateId = 10): TelegramJob {
  return parseTelegramJob("telegram.updates", { kind: "telegram_update", update: { update_id: updateId, ...body } });
}

const channelPost = (messageId: number, extra: Record<string, unknown> = {}) => ({
  message_id: messageId, date: 1_789_000_000, chat: { id: -1001234, type: "channel" }, text: "tip", ...extra,
});

describe("contrato dos jobs telegram.*", () => {
  it("aceita o job com a correlação de observabilidade e a tira dele", () => {
    const correlated = [
      { _observability: { correlationId: "job_1" }, kind: "channel_photo", chatId: "-1001", messageId: 5, caption: "", postDate: POST_DATE, fileId: "f" },
      { _observability: { correlationId: "job_2" }, kind: "edited_channel_post", chatId: "-1001", messageId: 6, text: "t", postDate: POST_DATE, editDate: EDIT_DATE },
    ];
    for (const data of correlated) {
      const job = parseTelegramJob("telegram.updates", data);
      expect(job).not.toHaveProperty("_observability");
      expect(job.kind).toBe(data.kind);
    }
  });

  it("aceita cada job que os handlers ao vivo produzem", () => {
    const jobs = [
      { kind: "channel_post", chatId: "-1", messageId: 1, text: "t", postDate: POST_DATE, forcedByOperator: true },
      { kind: "edited_channel_photo", chatId: "-1", messageId: 1, caption: "c", postDate: POST_DATE, editDate: EDIT_DATE, fileId: "f", mediaGroupId: "g" },
      { kind: "channel_photo_album", chatId: "-1", messageId: 1, caption: "", postDate: POST_DATE, fileId: "", mediaGroupId: "g" },
      { kind: "reaction", chatId: "-1", messageId: 1, emojis: ["👎"], occurredAt: POST_DATE, updateId: 4, thumbsDownPresent: true },
      { kind: "dm_message", chatId: "77", messageId: 3, postDate: POST_DATE, fileId: "f", caption: "c" },
    ];
    for (const data of jobs) expect(parseTelegramJob("telegram.updates", data)).toEqual(data);
  });

  it("recusa payload fora do contrato dizendo o motivo", () => {
    expect(() => parseTelegramJob("telegram.updates", { kind: "channel_photo", chatId: "-1", messageId: 1, caption: "", postDate: POST_DATE }))
      .toThrow(InvalidTelegramJobError);
    expect(() => parseTelegramJob("telegram.updates", { kind: "channel_post", chatId: "abc", messageId: 1, text: "", postDate: POST_DATE }))
      .toThrow(/telegram\.updates fora do contrato: chatId/);
    expect(() => parseTelegramJob("telegram.updates", { kind: "desconhecido" })).toThrow(/kind/);
  });
});

describe("roteamento na fila ordenada", () => {
  it("post e edição do mesmo post dividem a chave; posts diferentes não", () => {
    const post = routeTelegramJob(update({ channel_post: channelPost(7) }, 10));
    const edit = routeTelegramJob(update({ edited_channel_post: { ...channelPost(7), edit_date: 1_789_000_100 } }, 11));
    const normalizedEdit = routeTelegramJob({ kind: "edited_channel_post", chatId: "-1001234", messageId: 7, text: "t", postDate: POST_DATE, editDate: EDIT_DATE });
    const other = routeTelegramJob(update({ channel_post: channelPost(8) }, 12));
    expect(post.orderingKey).toBe("tg:-1001234:msg:7");
    expect(edit.orderingKey).toBe(post.orderingKey);
    expect(normalizedEdit.orderingKey).toBe(post.orderingKey);
    expect(other.orderingKey).not.toBe(post.orderingKey);
    expect(new Set([post.group, edit.group, other.group])).toEqual(new Set(["-1001234"]));
  });

  it("membros de álbum ficam na chave do álbum; a reação, na da mensagem", () => {
    const member = routeTelegramJob(update({ channel_post: channelPost(9, { media_group_id: "album-1" }) }));
    const staged = routeTelegramJob({ kind: "channel_photo_album", chatId: "-1001234", messageId: 10, caption: "", postDate: POST_DATE, fileId: "f", mediaGroupId: "album-1" });
    const reaction = routeTelegramJob(update({ message_reaction_count: { chat: { id: -1001234 }, message_id: 9, date: 1, reactions: [] } }));
    expect(member.orderingKey).toBe("tg:-1001234:album:album-1");
    expect(staged.orderingKey).toBe(member.orderingKey);
    expect(reaction.orderingKey).toBe("tg:-1001234:msg:9");
  });

  it("a escolha da banca na DM entra na fila da mensagem que ela responde", () => {
    const message = routeTelegramJob(update({ message: { message_id: 30, date: 1, chat: { id: 77, type: "private" }, text: "tip" } }));
    const callback = routeTelegramJob(update({ callback_query: { id: "cb", data: "dm:b1", message: {
      message_id: 31, date: 1, chat: { id: 77, type: "private" },
      reply_to_message: { message_id: 30, date: 1, chat: { id: 77, type: "private" } },
    } } }));
    const retry = routeTelegramJob({ kind: "dm_message", chatId: "77", messageId: 30, postDate: POST_DATE, text: "tip" });
    expect(message.orderingKey).toBe("tg:dm:77:30");
    expect(callback.orderingKey).toBe(message.orderingKey);
    expect(retry.orderingKey).toBe(message.orderingKey);
  });

  it("clique e resposta do conserto entram na fila da pergunta", () => {
    const click = routeTelegramJob(update({ callback_query: { id: "cb", data: "fx:a", message: {
      message_id: 40, date: 1, chat: { id: 77, type: "private" }, text: "🛠️ pergunta",
    } } }));
    const reply = routeTelegramJob(update({ message: {
      message_id: 41, date: 1, chat: { id: 77, type: "private" }, text: "1.9",
      reply_to_message: { message_id: 40, date: 1, chat: { id: 77, type: "private" } },
    } }));
    expect(click.orderingKey).toBe("tg:dm:77:40");
    expect(reply.orderingKey).toBe(click.orderingKey);
  });

  it("update sem post conhecido tem chave própria em vez de ser descartado", () => {
    const unknown = routeTelegramJob(update({ tipo_futuro: { qualquer: true } }, 55));
    expect(unknown.orderingKey).toBe("tg:update:55");
  });

  it("o mesmo update reentregue tem o mesmo id; update ou conteúdo diferente, outro id", () => {
    const first = routeTelegramJob(update({ channel_post: channelPost(7) }, 10));
    const again = routeTelegramJob(update({ channel_post: channelPost(7) }, 10));
    const next = routeTelegramJob(update({ channel_post: channelPost(7) }, 11));
    expect(again.id).toBe(first.id);
    expect(next.id).not.toBe(first.id);
    expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const job = { kind: "channel_post", chatId: "-1", messageId: 1, text: "t", postDate: POST_DATE } as const;
    expect(routeTelegramJob(parseTelegramJob("q", { ...job, _observability: { correlationId: "a" } })).id)
      .toBe(routeTelegramJob(job).id);
    expect(routeTelegramJob({ ...job, text: "outro" }).id).not.toBe(routeTelegramJob(job).id);
  });
});
