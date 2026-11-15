import { OperationalRisk, type Prisma } from "@/src/generated/prisma/client";
import type { NormalizeMercadoResult } from "@/src/services/mercados/normalize";
import { reportOperationalActionTx } from "@/src/services/ops/operational-actions";

type AliasConflict = NonNullable<NormalizeMercadoResult["aliasConflict"]>;

/** Persiste a decisão humana exigida sem fazer I/O externo dentro da transação. */
export async function reportMercadoAliasConflictTx(
  tx: Prisma.TransactionClient,
  input: {
    betId: string;
    mercadoRecebido: string;
    esporte: string;
    conflict: AliasConflict;
  },
): Promise<void> {
  await reportOperationalActionTx(tx, {
    source: "mercado.alias-conflict",
    key: input.betId,
    area: "mercados",
    actionType: "mercado.alias_conflict",
    title: "Alias de mercado com múltiplos destinos",
    description:
      `A aposta ${input.betId} ficou PENDING com o mercado recebido ` +
      `"${input.mercadoRecebido}". Corrija a chave ambígua antes de reprocessar; ` +
      "nenhum destino foi escolhido automaticamente.",
    risk: OperationalRisk.HIGH,
    resource: "bet",
    resourceId: input.betId,
    evidence: {
      esporte: input.esporte,
      aliasNormalizado: input.conflict.aliasNormalizado,
      casaDeAposta: input.conflict.casaDeAposta,
      destinos: input.conflict.destinos,
    },
    autoResolve: false,
  });
}
