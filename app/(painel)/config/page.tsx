import { loadPlayersAction, curatePlayerAction } from "./player-actions";
import { headers } from "next/headers";
import { themeMode } from "@/app/_lib/theme-mode";
import { getConfigData } from "@/app/_design/adapters/config";
import {
  addMarketAliasAction,
  createBankrollAction,
  editarBankrollAction,
  removeLogoAction,
  removeMarketAliasAction,
  revokeOtherSessionsAction,
  revokeSessionAction,
  excluirBankrollAction,
  uploadLogoAction,
  loadCatalogPairingAction,
  requestCatalogPairingAction,
  loadTeamCardsAction,
  removeTipsterNameAction,
} from "./actions";
import { ConfigClient } from "./ConfigClient";
import { mockFixture } from "@/app/(painel)/_mock";
import { canManage as sessionCanManage } from "../_auth";
import { operadorAtual } from "../_operador";

export const dynamic = "force-dynamic";

/**
 * Config — `ConfigScreen`. `?mock=1` usa o
 * dado do design e NÃO passa as actions (mutação nunca toca o banco real sobre
 * dado fake — espelha o gate de Contas). Sem isso, dado real via adaptador
 * (bancas, taxonomia de mercados e fichas de times).
 */
export default async function ConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ mock?: string }>;
}) {
  const sp = await searchParams;
  const [mode, headerStore] = await Promise.all([themeMode(), headers()]);
  const fixture = await mockFixture(sp.mock, () => import("@/app/_design/mock/config"));
  if (fixture) {
    const { CFG } = fixture;
    return <ConfigClient data={CFG} initialMode={mode} />;
  }
  const username = await operadorAtual();
  const [data, canManage] = await Promise.all([
    getConfigData(username, headerStore.get("x-auth-session-id")),
    sessionCanManage(),
  ]);
  return (
    <ConfigClient
      data={data}
      canManage={canManage}
      onLoadTeamCards={loadTeamCardsAction}
      onRemoveTipsterName={canManage ? removeTipsterNameAction : undefined}
      onRequestCatalogPairing={canManage ? requestCatalogPairingAction : undefined}
      onLoadCatalogPairing={loadCatalogPairingAction}
      onLoadPlayers={loadPlayersAction}
      onPlayerCommand={canManage ? curatePlayerAction : undefined}
      onCreateBanca={canManage ? createBankrollAction : undefined}
      onEditBanca={canManage ? editarBankrollAction : undefined}
      onRemoveBanca={canManage ? excluirBankrollAction : undefined}
      onAddAlias={canManage ? addMarketAliasAction : undefined}
      onRemoveAlias={canManage ? removeMarketAliasAction : undefined}
      onUploadLogo={canManage ? uploadLogoAction : undefined}
      onRemoveLogo={canManage ? removeLogoAction : undefined}
      onRevokeSession={canManage ? revokeSessionAction : undefined}
      onRevokeOtherSessions={canManage ? revokeOtherSessionsAction : undefined}
      initialMode={mode}
    />
  );
}
