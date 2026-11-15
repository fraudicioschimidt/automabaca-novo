"use client";

import { ConfigScreen } from "@/app/_design/screens/ConfigScreen";
import { DesignScreen } from "@/app/_design/DesignScreen";
import type { getConfigData } from "@/app/_design/adapters/config";
import { unwrapAction } from "@/app/_design/action-contracts";
import type {
  addMarketAliasAction,
  createBankrollAction,
  editarBankrollAction,
  excluirBankrollAction,
  loadCatalogPairingAction,
  loadTeamCardsAction,
  removeLogoAction,
  removeMarketAliasAction,
  removeTipsterNameAction,
  requestCatalogPairingAction,
  revokeOtherSessionsAction,
  revokeSessionAction,
  uploadLogoAction,
} from "./actions";
import type { curatePlayerAction, loadPlayersAction } from "./player-actions";

type ConfigData = Awaited<ReturnType<typeof getConfigData>>;

export function ConfigClient({
  data,
  onLoadTeamCards,
  onRemoveTipsterName,
  onRequestCatalogPairing,
  onLoadCatalogPairing,
  onLoadPlayers,
  onPlayerCommand,
  onCreateBanca,
  onEditBanca,
  onRemoveBanca,
  onAddAlias,
  onRemoveAlias,
  onUploadLogo,
  onRemoveLogo,
  onRevokeSession,
  onRevokeOtherSessions,
  canManage = true,
  initialMode,
}: {
  data: ConfigData;
  // Ausentes no ?mock=1: a tela degrada para otimista-local (nunca toca o banco real).
  onLoadTeamCards?: typeof loadTeamCardsAction;
  onRemoveTipsterName?: typeof removeTipsterNameAction;
  onLoadPlayers?: typeof loadPlayersAction;
  onPlayerCommand?: typeof curatePlayerAction;
  onRequestCatalogPairing?: typeof requestCatalogPairingAction;
  onLoadCatalogPairing?: typeof loadCatalogPairingAction;
  onCreateBanca?: typeof createBankrollAction;
  onEditBanca?: typeof editarBankrollAction;
  onRemoveBanca?: typeof excluirBankrollAction;
  onAddAlias?: typeof addMarketAliasAction;
  onRemoveAlias?: typeof removeMarketAliasAction;
  onUploadLogo?: typeof uploadLogoAction;
  onRemoveLogo?: typeof removeLogoAction;
  onRevokeSession?: typeof revokeSessionAction;
  onRevokeOtherSessions?: typeof revokeOtherSessionsAction;
  canManage?: boolean;
  initialMode: "light" | "dark";
}) {
  return (
    <DesignScreen initialMode={initialMode}>
      <ConfigScreen
        data={data}
        canManage={canManage}
        onLoadTeamCards={onLoadTeamCards}
        onRemoveTipsterName={onRemoveTipsterName && unwrapAction(onRemoveTipsterName)}
        onRequestCatalogPairing={onRequestCatalogPairing && unwrapAction(onRequestCatalogPairing)}
        onLoadCatalogPairing={onLoadCatalogPairing}
        onLoadPlayers={onLoadPlayers}
        onPlayerCommand={onPlayerCommand && unwrapAction(onPlayerCommand)}
        onCreateBanca={onCreateBanca && unwrapAction(onCreateBanca)}
        onEditBanca={onEditBanca && unwrapAction(onEditBanca)}
        onRemoveBanca={onRemoveBanca}
        onAddAlias={onAddAlias && unwrapAction(onAddAlias)}
        onRemoveAlias={onRemoveAlias && unwrapAction(onRemoveAlias)}
        onUploadLogo={onUploadLogo && unwrapAction(onUploadLogo)}
        onRemoveLogo={onRemoveLogo && unwrapAction(onRemoveLogo)}
        onRevokeSession={onRevokeSession && unwrapAction(onRevokeSession)}
        onRevokeOtherSessions={onRevokeOtherSessions && unwrapAction(onRevokeOtherSessions)}
      />
    </DesignScreen>
  );
}
