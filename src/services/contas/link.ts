import type { Prisma } from "@/src/generated/prisma/client";
import { canonicalizeBookmakerName } from "@/src/domain/bookmaker";
import { normalizeStr } from "@/src/domain/text";

/**
 * Vínculo automático aposta → conta: dado o bankroll e a casa da aposta,
 * encontra a conta ATIVA daquela casa. Preferência: conta vinculada ao
 * bankroll (ContaBankroll) > conta sem vínculos (global). Mais de uma conta
 * elegível no mesmo nível é ambígua e falha fechada; escolher a mais antiga
 * lançaria dinheiro num ledger arbitrário.
 */
export type ContaParaCasaResolution = {
  contaId: string | null;
  /** Há conta da casa, mas nenhuma única elegível para este bankroll. */
  blockedByExistingAccounts: boolean;
  /** As contas vivas da casa estão todas LIMITADA: a casa não aceita aposta nova. */
  onlyLimited?: boolean;
};

function bookmakerIdentity(value: string): string {
  return normalizeStr(canonicalizeBookmakerName(value));
}

/**
 * A conta é da casa da aposta? A mesma identidade do vínculo automático:
 * comparar de outro jeito na liquidação ou na edição tiraria a aposta da
 * conta em que ela foi ligada ("Betano BR" × "Betano", "Lotérica" × "Loterica").
 */
export function isSameBookmaker(a: string, b: string): boolean {
  const identity = bookmakerIdentity(a);
  return identity !== "" && identity === bookmakerIdentity(b);
}

export async function resolveContaAtivaParaCasa(
  tx: Prisma.TransactionClient,
  params: { bankrollId: string; casaDeAposta: string },
): Promise<ContaParaCasaResolution> {
  const casaNorm = bookmakerIdentity(params.casaDeAposta);
  if (!casaNorm) return { contaId: null, blockedByExistingAccounts: false };

  // Traz toda conta viva da casa, não só a ATIVA: uma LIMITADA continua sendo
  // do titular, e sem ela a casa pareceria sem conta e a aposta liquidaria sem
  // ledger e sem aviso. Aposta NOVA só entra em conta ATIVA; a que já estava
  // ligada a uma LIMITADA segue nela (`resolveSettlementConta`).
  const vivas = await tx.conta.findMany({
    where: { status: { in: ["ATIVA", "LIMITADA"] }, deletedAt: null },
    select: {
      id: true,
      status: true,
      casaDeAposta: true,
      bankrollLinks: {
        select: { bankrollId: true },
      },
    },
  });

  const daCasa = vivas.filter(
    (c) => bookmakerIdentity(c.casaDeAposta) === casaNorm,
  );
  if (daCasa.length === 0) return { contaId: null, blockedByExistingAccounts: false };

  const ativas = daCasa.filter((c) => c.status === "ATIVA");
  if (ativas.length === 0) return { contaId: null, blockedByExistingAccounts: true, onlyLimited: true };

  const doBankroll = ativas.filter((c) =>
    c.bankrollLinks.some((l) => l.bankrollId === params.bankrollId),
  );
  if (doBankroll.length > 0) {
    return {
      contaId: doBankroll.length === 1 ? doBankroll[0]!.id : null,
      blockedByExistingAccounts: doBankroll.length !== 1,
    };
  }

  const globais = ativas.filter((c) => c.bankrollLinks.length === 0);
  return {
    contaId: globais.length === 1 ? globais[0]!.id : null,
    blockedByExistingAccounts: globais.length !== 1,
  };
}

export async function findContaAtivaParaCasa(
  tx: Prisma.TransactionClient,
  params: { bankrollId: string; casaDeAposta: string },
): Promise<string | null> {
  return (await resolveContaAtivaParaCasa(tx, params)).contaId;
}
