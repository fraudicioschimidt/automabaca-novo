import "server-only";
import { fonteDeFrescor, type Frescor, frescorDaFonte } from "@/src/domain/frescor";
import { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/infra/prisma";

/**
 * De quando é o dado que o Analyzer mostra: o de uma banca ou, sem
 * `bankrollId`, o da carteira inteira. A última aposta capturada e o último
 * fechamento gravado para essas apostas. São fontes sem cadência (o relógio é
 * do mundo), então informam a idade mas nunca alarmam; ver `src/domain/frescor`.
 * Na banca, a captura usa o índice (bankrollId, registradoEm); o fechamento vai
 * pela PK de bet_closing.
 */
export async function getFrescorDosDados(
  bankrollId: string | null,
  agora: Date = new Date(),
): Promise<{ captura: Frescor; fechamento: Frescor }> {
  const daBanca = bankrollId === null ? Prisma.empty : Prisma.sql`AND "bankrollId" = ${bankrollId}`;
  const daBancaDaAposta = bankrollId === null ? Prisma.empty : Prisma.sql`AND b."bankrollId" = ${bankrollId}`;
  const [instantes] = await prisma.$queryRaw<Array<{ captura: Date | null; fechamento: Date | null }>>`
    SELECT
      (SELECT max("registradoEm") FROM bets
         WHERE "deletedAt" IS NULL ${daBanca}) AS "captura",
      (SELECT max(c."fetchedAt") FROM bet_closing c
         JOIN bets b ON b.id = c."betId"
         WHERE b."deletedAt" IS NULL ${daBancaDaAposta}) AS "fechamento"
  `;
  return {
    captura: frescorDaFonte(fonteDeFrescor("captura"), instantes?.captura ?? null, agora),
    fechamento: frescorDaFonte(fonteDeFrescor("fechamento"), instantes?.fechamento ?? null, agora),
  };
}
