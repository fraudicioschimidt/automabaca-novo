import {
  applyManualBetStatusChangeTx,
  type ApplyBetStatusChangeParams,
  type ApplyBetStatusChangeResult,
} from "@/src/services/bets/settle";
import { finishBetStatusChange } from "@/src/services/bets/settle-effects";
import {
  type SerializableTransactionClient,
  runSerializableTransaction,
} from "@/src/services/shared/transaction";

/**
 * Correção manual direta, sem a confirmação de versão da tela: mesma transação
 * e mesmos efeitos pós-commit que `settleManualFromView` usa em produção.
 */
export async function applyManualBetStatusChange(
  params: ApplyBetStatusChangeParams,
  options?: { client?: SerializableTransactionClient },
): Promise<ApplyBetStatusChangeResult> {
  const result = await runSerializableTransaction(
    "test.applyManualBetStatusChange",
    (tx) => applyManualBetStatusChangeTx(tx, params),
    options,
  );
  await finishBetStatusChange(params.betId, result);
  return result;
}
