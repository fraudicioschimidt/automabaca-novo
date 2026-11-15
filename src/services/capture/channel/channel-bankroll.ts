import type { CaptureImage } from "@/src/domain/bet-capture";
import { getEnv } from "@/src/infra/env";
import { telegramPostLink } from "@/src/domain/telegram-source";
import { createLogger } from "@/src/infra/logger";
import { findBankrollByChannel, type ChannelBankroll } from "@/src/services/bankrolls/lookup";
import { CHANNEL_BANKROLL_DEFAULTS, createChannelBankroll, isChannelRetiredByOwner } from "@/src/services/bankrolls/manage";
import { prepareLogoImage, writeLogoFile } from "@/src/services/logos/storage";
import { sendOperationalAlert, sendOperatorNotification } from "@/src/services/ops/alerts";
import { CHANNEL_NOT_OWNED, isChannelKnownAsNotOwned, recordUnmappedChannel } from "@/src/services/capture/channel/channel-post-archive";

const log = createLogger("tg-channel-bankroll");

/** O que o Telegram diz do canal: nome, foto e se algum usuário autorizado o administra. */
export type ChannelProfile = { title: string; photoFileId: string | null; operatorIsAdmin: boolean };

/** Acesso à Bot API que a captura usa fora do update: fotos e o perfil do canal. */
export type ChannelCaptureDeps = {
  loadImage?: (fileId: string) => Promise<CaptureImage>;
  loadChannelProfile?: (chatId: bigint) => Promise<ChannelProfile>;
};

type ChannelContent = { kind: "text" | "photo"; text: string; mediaFileId?: string };
/** O post que não é capturado por falta de banca. */
type UnmappedChannelOutcome = { kind: "skipped"; reason: "canal_sem_bankroll" | "canal_de_banca_excluida" };
type UnmappedReason = "sem_perfil" | "banca_excluida" | typeof CHANNEL_NOT_OWNED;

/**
 * Banca do canal. Canal novo ganha banca na hora, com o nome e a foto do
 * canal, e o próprio post segue a captura. Não cria quando o dono já tirou o
 * canal de uma banca nem quando ele não administra o canal: aí o post fica
 * guardado e o alerta pede o vínculo em Config. Do canal que o dono não
 * administra fica só o registro do canal, sem o conteúdo do post, e a
 * consulta ao Telegram se repete uma vez por intervalo do registro.
 */
export async function resolveChannelBankroll(
  post: { chatId: bigint; messageId: number },
  content: ChannelContent,
  deps: ChannelCaptureDeps,
): Promise<{ bankroll: ChannelBankroll } | { outcome: UnmappedChannelOutcome }> {
  const mapped = await findBankrollByChannel(post.chatId);
  if (mapped) return { bankroll: mapped };
  if (!deps.loadChannelProfile) return { outcome: await skipUnmappedChannel(post, content, "sem_perfil") };
  if (await isChannelRetiredByOwner(post.chatId)) return { outcome: await skipUnmappedChannel(post, content, "banca_excluida") };
  // Canal alheio já visto: sem consulta ao Telegram, registro nem aviso por post.
  if (await isChannelKnownAsNotOwned(post.chatId)) return { outcome: { kind: "skipped", reason: "canal_sem_bankroll" } };
  const profile = await deps.loadChannelProfile(post.chatId);
  if (!profile.operatorIsAdmin) {
    return { outcome: await skipUnmappedChannel(post, content, CHANNEL_NOT_OWNED, profile.title) };
  }
  const created = await createChannelBankroll({ chatId: post.chatId, title: profile.title });
  if (created.kind === "retired") return { outcome: await skipUnmappedChannel(post, content, "banca_excluida", profile.title) };
  if (created.kind === "created") {
    const withLogo = await saveChannelLogo(created.id, created.slug, profile.photoFileId, deps);
    await sendOperatorNotification(
      `🆕 Tipster criado: ${created.nome}\n` +
        `O canal ${post.chatId} mandou o primeiro post e ainda não tinha tipster.\n` +
        `Configurei: unidade de R$ ${CHANNEL_BANKROLL_DEFAULTS.valorUnidade}, capital de ${CHANNEL_BANKROLL_DEFAULTS.capitalInicial}u, ` +
        `stake só a do post, CLV contra o fechamento, sem casa padrão, esportes "vários/não sei", ${withLogo ? "com a foto do canal como logo" : "sem logo"}.\n` +
        "👉 Ajuste o que precisar em Config › Tipsters (marcar o esporte do canal poupa a busca do esporte de cada aposta)." +
        postLinkLine(post),
    );
  }
  const bankroll = await findBankrollByChannel(post.chatId);
  return bankroll ? { bankroll } : { outcome: await skipUnmappedChannel(post, content, "sem_perfil") };
}

/** A logo é enfeite: falha fica no log e a banca segue sem ela. */
async function saveChannelLogo(ownerId: string, slug: string, photoFileId: string | null, deps: ChannelCaptureDeps): Promise<boolean> {
  if (!photoFileId || !deps.loadImage) return false;
  if (!getEnv().LOGOS_DIR) {
    log.warn({ slug }, "LOGOS_DIR ausente neste processo — banca criada sem logo");
    return false;
  }
  try {
    const photo = await deps.loadImage(photoFileId);
    const { ext, image } = await prepareLogoImage(Buffer.from(photo.base64, "base64"));
    await writeLogoFile(slug, ext, image, ownerId);
    return true;
  } catch (err) {
    log.warn({ err, slug }, "logo do canal não gravada — banca criada sem logo");
    return false;
  }
}

/** O link do post numa linha própria, quando o canal tem um. */
function postLinkLine(post: { chatId: bigint; messageId: number }): string {
  const link = telegramPostLink(post.chatId, post.messageId);
  return link ? `\n${link}` : "";
}

const UNMAPPED_MESSAGES: Record<UnmappedReason, (what: string, channel: string) => string> = {
  sem_perfil: (what, channel) =>
    `📡 Canal sem tipster vinculado\nChegou o ${what} do canal ${channel}, mas nenhum tipster usa esse canal, então nada foi capturado.\n` +
    "👉 Em Config, informe o ID do canal no tipster certo.",
  banca_excluida: (what, channel) =>
    `📡 Post de canal que você tirou de um tipster\nChegou o ${what} do canal ${channel}, que era de um tipster excluído (ou que teve o canal apagado). ` +
    "Não recriei o tipster e nada foi capturado.\n👉 Para voltar a capturar, informe o ID do canal num tipster em Config.",
  dono_nao_administra: (what, channel) =>
    `📡 Canal sem tipster vinculado\nChegou o ${what} do canal ${channel}, mas você não é dono nem administrador dele, então não criei tipster e nada foi capturado.\n` +
    "👉 Se quer capturar este canal, informe o ID dele num tipster em Config.",
};

/** Canal sem banca: guarda o post para o painel (o de canal alheio, sem o conteúdo) e pede o vínculo em Config. */
async function skipUnmappedChannel(
  post: { chatId: bigint; messageId: number },
  content: ChannelContent,
  reason: UnmappedReason,
  title?: string,
): Promise<UnmappedChannelOutcome> {
  log.info({ chatId: String(post.chatId), messageId: post.messageId, reason }, "post de canal sem banca — não capturado");
  const stored = reason === CHANNEL_NOT_OWNED ? { kind: content.kind } : content;
  await recordUnmappedChannel({ chatId: post.chatId, messageId: post.messageId, ...stored, reason });
  const what = `${content.kind === "text" ? "post" : "foto"} ${post.messageId}`;
  await sendOperationalAlert(UNMAPPED_MESSAGES[reason](what, title ? `${post.chatId} (${title})` : String(post.chatId)) + postLinkLine(post), {
    source: "telegram.unmapped-channel",
    key: String(post.chatId),
    title: "Canal Telegram sem tipster",
    resource: "telegram-channel",
    resourceId: String(post.chatId),
    evidence: { messageId: post.messageId, reason },
    autoResolve: false,
  });
  return { kind: "skipped", reason: reason === "banca_excluida" ? "canal_de_banca_excluida" : "canal_sem_bankroll" };
}
