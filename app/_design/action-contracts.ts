import type * as contas from "@/app/(painel)/contas/actions";
import type * as operacoes from "@/app/(painel)/operacoes/actions";
import type * as bets from "@/app/(painel)/tipsters/[slug]/manual-actions";
import type * as banca from "@/app/(painel)/tipsters/[slug]/actions";
import type * as config from "@/app/(painel)/config/actions";
import type * as jogadores from "@/app/(painel)/config/player-actions";
import type { getContasData } from "./adapters/contas";
import type { getOperacoesData } from "./adapters/operacoes";
import type { getApostaBet } from "./adapters/aposta";

/**
 * A action como a tela a chama. A action devolve a recusa como
 * `{ ok: false, erro }`, porque o Next esconde a mensagem de erro lançado no
 * servidor; `unwrapAction` a transforma em exceção criada no cliente, com a
 * mensagem intacta, e o `catch` de cada tela a mostra.
 */
export type Unwrapped<F> = F extends (...args: infer A) => Promise<infer R>
  ? (...args: A) => Promise<Extract<R, { ok: true }>>
  : never;

export function unwrapAction<A extends unknown[], R extends { ok: boolean }>(
  action: (...args: A) => Promise<R>,
): (...args: A) => Promise<Extract<R, { ok: true }>> {
  return async (...args) => {
    const result = await action(...args);
    if (!result.ok) {
      const erro = (result as { erro?: unknown }).erro;
      throw new Error(typeof erro === "string" && erro ? erro : "A ação foi recusada.");
    }
    return result as Extract<R, { ok: true }>;
  };
}

export type ContasData = Awaited<ReturnType<typeof getContasData>>;
export type OperacoesData = Awaited<ReturnType<typeof getOperacoesData>>;
export type ApostaData = Awaited<ReturnType<typeof getApostaBet>>;

export type ContaActions = {
  onMovimentar?: typeof contas.movimentarContaAction | null;
  onCriar?: typeof contas.criarContaAction | null;
  onEditar?: typeof contas.editarContaAction | null;
  onStatus?: typeof contas.alterarStatusContaAction | null;
  onRemover?: typeof contas.removerContaAction | null;
};

export type OperacoesActions = {
  onSettle?: typeof operacoes.settleBetsAction | null;
  onApproveIaJudge?: Unwrapped<typeof operacoes.approveIaJudgeAction> | null;
  onRejectIaJudge?: Unwrapped<typeof operacoes.rejectIaJudgeAction> | null;
  onResolveMatch?: Unwrapped<typeof operacoes.resolveMatchAction> | null;
  onIgnoreMatch?: Unwrapped<typeof operacoes.ignoreMatchAction> | null;
  onRetrySharp?: Unwrapped<typeof operacoes.retrySharpAction> | null;
};

export type ApostaActions = {
  onEditBet?: Unwrapped<typeof bets.editBetAction> | null;
  onDeleteBet?: Unwrapped<typeof bets.deleteBetAction> | null;
  /** O "Restaurar" da ficha de aposta removida. */
  onRestoreBets?: Unwrapped<typeof bets.restoreBetsAction> | null;
};

export type MonitoramentoActions = {
  onReplayJob?: Unwrapped<typeof operacoes.replayJobAction> | null;
  onAcknowledgeAction?: Unwrapped<typeof operacoes.acknowledgeOperationalActionAction> | null;
  onResolveAction?: Unwrapped<typeof operacoes.resolveOperationalActionAction> | null;
  onRetryChannelTransient?: Unwrapped<typeof operacoes.retryChannelTransientAction> | null;
  onCaptureDiscardedPost?: Unwrapped<typeof operacoes.captureDiscardedPostAction> | null;
};

/** O cliente embrulha as mutações para atualizar a rota; a assinatura é a da action. */
export type BankrollActions = {
  onFetchClosing?: Unwrapped<typeof banca.buscarFechamentoAction> | null;
  onSettleBet?: typeof banca.settleBetAction | null;
  onDeleteBet?: Unwrapped<typeof bets.deleteBetAction> | null;
  onExportCsv?: Unwrapped<typeof banca.exportBankrollCsvAction> | null;
  onRegisterBet?: Unwrapped<typeof bets.registerManualBetAction> | null;
  onChangeSharpMode?: Unwrapped<typeof banca.updateBankrollSharpModeAction> | null;
  onPreviewRemoval?: Unwrapped<typeof bets.previewBetRemovalAction> | null;
  onRemoveBets?: Unwrapped<typeof bets.removeBetsAction> | null;
  onRestoreBets?: Unwrapped<typeof bets.restoreBetsAction> | null;
};

export type ConfigActions = {
  onLoadTeamCards?: typeof config.loadTeamCardsAction | null;
  onRemoveTipsterName?: Unwrapped<typeof config.removeTipsterNameAction> | null;
  /** "Buscar jogos agora": enfileira uma rodada do pareamento dos catálogos. */
  onRequestCatalogPairing?: Unwrapped<typeof config.requestCatalogPairingAction> | null;
  onLoadCatalogPairing?: typeof config.loadCatalogPairingAction | null;
  onLoadPlayers?: typeof jogadores.loadPlayersAction | null;
  onPlayerCommand?: Unwrapped<typeof jogadores.curatePlayerAction> | null;
  onCreateBanca?: Unwrapped<typeof config.createBankrollAction> | null;
  onEditBanca?: Unwrapped<typeof config.editarBankrollAction> | null;
  onRemoveBanca?: typeof config.excluirBankrollAction | null;
  onAddAlias?: Unwrapped<typeof config.addMarketAliasAction> | null;
  onRemoveAlias?: Unwrapped<typeof config.removeMarketAliasAction> | null;
  onUploadLogo?: Unwrapped<typeof config.uploadLogoAction> | null;
  onRemoveLogo?: Unwrapped<typeof config.removeLogoAction> | null;
  onRevokeSession?: Unwrapped<typeof config.revokeSessionAction> | null;
  onRevokeOtherSessions?: Unwrapped<typeof config.revokeOtherSessionsAction> | null;
};
