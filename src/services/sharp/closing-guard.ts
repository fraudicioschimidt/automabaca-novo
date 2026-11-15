import type { Prisma } from "@/src/generated/prisma/client";
import type { NoOddsReason } from "@/src/domain/no-odds-reason";
import { prisma } from "@/src/infra/prisma";

/**
 * Escrita de BetClosing com guard de corrida (cron × manual × revival ×
 * edição).
 * Garante a linha 1:1 e só aplica `data` se o campo-guard ainda for null —
 * o UPDATE condicional do Postgres re-checa o WHERE após lock.
 *
 * - `fetchedAt` — sync/snapshot: “já tentou congelar CLV” (mesmo sem odd)
 * - `closingOdd` — revival: “odd de fechamento já existe” (não pisa manual/cron)
 *
 * O placar tem a guarda dele em `bet_result` (`writeScoreOnce`).
 */

export type ClosingWriteGuard = "fetchedAt" | "closingOdd";

/**
 * Igual ao input do Prisma, exceto por `noOddsReason`, que é vocabulário
 * FECHADO (`src/domain/no-odds-reason`). O Prisma tipa a coluna como `string`,
 * o que deixaria qualquer slug entrar no banco sem a UI saber traduzi-lo.
 */
export type ClosingWriteData =
  Omit<Prisma.BetClosingUpdateManyMutationInput, "noOddsReason"> & {
    noOddsReason?: NoOddsReason | null;
  };

/**
 * A aposta como a consulta ao provider a leu. A consulta leva minutos (o
 * portão da Bridge, o lote em série), e a edição no meio apaga a abertura, o
 * fechamento e a identidade do jogo antigo: a escrita atrasada só vale se a
 * aposta ainda tem os termos e a identidade da leitura.
 */
export type BetAsRead = {
  id: string;
  evento: string;
  esporte: string;
  mercado: string;
  selecao: string;
  data: Date;
  sharp: { provider: string | null; providerMatchId: string | null } | null;
};

/** A aposta viva, ainda com os termos e a identidade da leitura. */
export function sameBetAsRead(bet: BetAsRead): Prisma.BetWhereInput {
  return {
    id: bet.id,
    deletedAt: null,
    evento: bet.evento,
    esporte: bet.esporte,
    mercado: bet.mercado,
    selecao: bet.selecao,
    data: bet.data,
    sharp: bet.sharp
      ? { is: { provider: bet.sharp.provider, providerMatchId: bet.sharp.providerMatchId } }
      : { is: null },
  };
}

export async function writeClosingOnce(
  bet: BetAsRead,
  guard: ClosingWriteGuard,
  data: ClosingWriteData,
  opts?: {
    /**
     * Odd da aposta usada no cálculo do CLV. A edição só da odd no meio da
     * consulta ao provider mantém a aposta da leitura e troca a odd; sem esta
     * trava a escrita atrasada entraria com o CLV da odd antiga.
     */
    expectedOdds?: Prisma.Decimal | number;
    /**
     * Instante da cotação da Pinnacle17 sem CLV confiável (cedo demais, ou sem
     * a linha nos minutos finais) que esta escrita substitui. Além do
     * campo-guard nulo, aceita a linha que ainda guarda exatamente aquela
     * cotação; se outra escrita já a trocou (ou foi manual), não grava.
     */
    replacingUnreliableQuoteAt?: Date;
    client?: Prisma.TransactionClient | typeof prisma;
  },
): Promise<boolean> {
  const db = opts?.client ?? prisma;
  // A aposta que mudou desde a leitura não ganha nem a linha vazia de volta.
  if (await db.bet.count({ where: sameBetAsRead(bet) }) === 0) return false;
  // INSERT ... SELECT torna existencia + soft-delete um unico gate atomico.
  // Um job antigo nao cria BetClosing para tip removida e um id hard-deletado
  // simplesmente nao produz linha, em vez de estourar a FK no worker.
  await db.$executeRaw`
    INSERT INTO bet_closing ("betId", "updatedAt")
    SELECT b.id, now()
    FROM bets b
    WHERE b.id = ${bet.id}
      AND b."deletedAt" IS NULL
      AND b."sportResolutionStatus" = 'CONFIRMED'
    ON CONFLICT ("betId") DO NOTHING
  `;
  const replacing = opts?.replacingUnreliableQuoteAt;
  const updated = await db.betClosing.updateMany({
    where: {
      betId: bet.id,
      ...(replacing
        ? { OR: [{ [guard]: null }, {
            provider: "pinnacle17", clvReliable: false, closingPriceObservedAt: replacing,
            source: { in: ["CRON" as const, "REPROCESS" as const] },
          }] }
        : { [guard]: null }),
      bet: {
        ...sameBetAsRead(bet),
        sportResolutionStatus: "CONFIRMED",
        ...(opts?.expectedOdds !== undefined ? { odds: opts.expectedOdds } : {}),
      },
    },
    data,
  });
  return updated.count > 0;
}
