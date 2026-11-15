import type { TestDb } from "./db";

/** Canal, post e banca comuns aos testes de canal contra Postgres real. */
export const CHANNEL_ID = -1001234567890n;
export const POST_DATE = new Date("2026-06-10T12:00:00Z");

export const POST_TEXT = [
  "⚽ Coquimbo Unido vs Colo Colo",
  "Data: 15/06 16:00",
  "Mercado: Resultado Final",
  "Entrada: Casa",
  "ODD: 2.10",
  "Stake: 1u",
].join("\n");

export function post(text: string, messageId = 555) {
  return { chatId: CHANNEL_ID, messageId, text, postDate: POST_DATE };
}

/** Edição do post: o Telegram sempre manda `edit_date`, e o resultado na legenda o exige. */
export function editedPost(text: string, editDate = new Date(POST_DATE.getTime() + 3_600_000), messageId = 555) {
  return { ...post(text, messageId), editDate };
}

export async function seedChannelBankroll(db: TestDb) {
  return db.prisma.bankroll.create({
    data: {
      nome: "Carteira Tips",
      slug: "carteira-tips",
      valorUnidade: 100,
      telegramChannelId: CHANNEL_ID,
      defaultBookmaker: "Betano",
    },
  });
}
