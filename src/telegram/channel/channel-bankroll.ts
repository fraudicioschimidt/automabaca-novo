import type { Api } from "grammy";
import { GrammyError } from "grammy";
import { telegramAllowedChats } from "@/src/infra/env";
import type { ChannelProfile } from "@/src/services/capture/channel/channel-bankroll";

/**
 * Qualquer pessoa pode pôr o bot como admin do próprio canal, e o dono pode
 * ser só assinante de um canal alheio: só canal que ele administra ganha banca
 * sozinho.
 */
const ADMIN_STATUSES = new Set(["creator", "administrator"]);

/**
 * Perfil do canal pela Bot API. Só a recusa sobre o membro (400/403: usuário
 * que o bot não enxerga) conta como "não administra"; 429, 5xx e erro de rede
 * sobem e o update volta pela fila de retry.
 */
export function telegramChannelProfileLoader(api: Api): (chatId: bigint) => Promise<ChannelProfile> {
  return async (chatId) => {
    const chat = await api.getChat(String(chatId));
    const title = "title" in chat && typeof chat.title === "string" ? chat.title : "";
    let operatorIsAdmin = false;
    for (const operator of telegramAllowedChats().users) {
      try {
        const member = await api.getChatMember(String(chatId), Number(operator));
        if (ADMIN_STATUSES.has(member.status)) { operatorIsAdmin = true; break; }
      } catch (err) {
        if (!(err instanceof GrammyError) || (err.error_code !== 400 && err.error_code !== 403)) throw err;
      }
    }
    return { title, photoFileId: chat.photo?.big_file_id ?? null, operatorIsAdmin };
  };
}
