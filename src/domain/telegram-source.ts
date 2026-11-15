/**
 * Formato das origens do Telegram gravadas em `bets.source` e
 * `bets.sourceExternalId`: montar e desmontar passa por aqui, nunca por
 * concatenação solta.
 */

/** Prefixo das origens de canal, para quem filtra por ele no SQL. */
export const CHANNEL_SOURCE_PREFIX = "telegram-channel:";
const DM_SOURCE_PREFIX = "telegram-dm:";
const CHANNEL_SOURCE = /^telegram-channel:(-?[1-9]\d*)$/;

export function telegramChannelSource(chatId: bigint | string): string {
  return `${CHANNEL_SOURCE_PREFIX}${chatId}`;
}

/** O canal de uma origem de canal; null para DM, web e o resto. */
export function channelIdFromSource(source: string): string | null {
  return CHANNEL_SOURCE.exec(source)?.[1] ?? null;
}

/**
 * A banca entra na origem de propósito: a mesma tip enviada na DM pode ser
 * registrada em várias bancas, e o unique (source, sourceExternalId) precisa
 * deduplicar cada destino separadamente.
 */
export function telegramDmSource(chatId: string, bankrollId: string): string {
  return `${DM_SOURCE_PREFIX}${chatId}:${bankrollId}`;
}

/** Autor da captura de canal no `bet.create`: o sufixo é o leitor, não o canal. */
export function telegramChannelActor(via: string): string {
  return `${CHANNEL_SOURCE_PREFIX}${via}`;
}

/**
 * `sourceExternalId` de uma aposta do post: a mensagem sozinha, ou
 * `<mensagem>:<n>` para o n-ésimo item de um lote do mesmo post.
 */
export function postItemExternalId(messageId: number | string, itemIndex?: number): string {
  return itemIndex ? `${messageId}:${itemIndex}` : String(messageId);
}

/** Filtro de `sourceExternalId` que serve a `bets` e a `retired_bet_sources`. */
export type ExternalIdsWhere = { OR: Array<{ sourceExternalId: string | { startsWith: string } }> };

/**
 * As apostas de um ou mais posts: a mensagem e os itens de lote (`<id>:<n>`).
 * O separador evita confundir as mensagens 42 e 420.
 */
export function postExternalIdsWhere(postIds: ReadonlyArray<string | number>): ExternalIdsWhere {
  return { OR: postIds.flatMap((id) => [{ sourceExternalId: String(id) }, { sourceExternalId: { startsWith: `${id}:` } }]) };
}

/** A mensagem de um `sourceExternalId`, sem o item de lote. */
export function postIdOfExternalId(externalId: string): string {
  return externalId.split(":")[0] ?? externalId;
}

/**
 * Rótulo curto da origem de uma aposta (ficha, exportação). O painel grava
 * `web-manual`; `web` é o padrão do registro para quem não diz a origem.
 */
export function captureOriginLabel(source: string): string {
  if (source.startsWith(CHANNEL_SOURCE_PREFIX)) return "Canal Telegram";
  if (source.startsWith(DM_SOURCE_PREFIX)) return "Telegram (DM)";
  if (source === "web" || source === "web-manual") return "Manual (web)";
  return source;
}

/**
 * Link que abre a mensagem direto no app, para quem é membro do canal. Só
 * canal e supergrupo (`-100…`) têm esse endereço.
 */
export function telegramPostLink(chatId: bigint | string, messageId: number | string): string | null {
  const chat = String(chatId);
  const message = String(messageId);
  if (!/^-100\d+$/.test(chat) || !/^[1-9]\d*$/.test(message)) return null;
  return `https://t.me/c/${chat.slice(4)}/${message}`;
}

/** Link do post de uma aposta de canal (o item de lote aponta para a mensagem). */
export function betPostLink(source: string, sourceExternalId: string | null): string | null {
  const chatId = channelIdFromSource(source);
  if (!chatId || !sourceExternalId) return null;
  return telegramPostLink(chatId, postIdOfExternalId(sourceExternalId));
}
