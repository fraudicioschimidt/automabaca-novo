"use client";
import { PlayersCard } from "./players-card";
import { BancasCard } from "./bancas-card";
import { MarketsCard } from "./markets-card";
import { TeamsCard } from "./teams-card";
import { SecurityCard } from "./security-card";
import { SegmentNav } from "../../kit/SegmentNav";
import { SEGMENTOS_DE_CONFIG } from "../../lib/segmentos-de-secao";
import type { ConfigActions } from "../../action-contracts";
import type { ConfigData } from "./types";
import type { BancasLista } from "./use-bancas";
import type { MarketsState } from "./use-markets";
import type { TeamCardsState } from "./use-team-cards";

type SectionActions = Pick<ConfigActions, "onRevokeSession" | "onRevokeOtherSessions" | "onLoadPlayers" | "onPlayerCommand">;

/**
 * Config em seções. Setup (bancas, segurança) e curadoria (mercados, times)
 * têm frequência diferente; numa coluna só, a curadoria enterrava o resto no
 * fim de uma rolagem que ninguém percorre.
 */
export function ConfigSections({ canManage, data, bancas, mercados, times, acoes, secao, onSelectSection }: {
  canManage: boolean;
  data: Pick<ConfigData, "marketCount" | "security">;
  bancas: BancasLista;
  mercados: MarketsState;
  times: TeamCardsState;
  acoes: SectionActions;
  secao: string;
  onSelectSection: (id: string) => void;
}) {
  // Bancas e times são ACERVO, não fila: o número diz o tamanho do cadastro,
  // e é por isso que ele não usa o token de atenção (ver `segmentos-de-secao`).
  const { inventory, ...teamCards } = times;
  const contagens = { bancas: bancas.bancas.length, times: inventory };

  return (
    <>
      <SegmentNav segmentos={SEGMENTOS_DE_CONFIG} contagens={contagens} ativo={secao} onSelecionar={onSelectSection} rotulo="Seções de configuração" />
      <div role="tabpanel" id={`segmento-painel-${secao}`} aria-labelledby={`segmento-tab-${secao}`}>
        {secao === "bancas" && <BancasCard {...bancas} canManage={canManage} />}
        {secao === "mercados" && <MarketsCard {...mercados} marketCount={data.marketCount} canManage={canManage} />}
        {secao === "times" && <TeamsCard {...teamCards} canManage={canManage} />}
        {secao === "jogadores" && <PlayersCard onLoad={acoes.onLoadPlayers ?? undefined} onCommand={acoes.onPlayerCommand ?? undefined} canManage={canManage} />}
        {secao === "seguranca" && (
          <SecurityCard security={data.security} onRevokeSession={acoes.onRevokeSession} onRevokeOtherSessions={acoes.onRevokeOtherSessions} />
        )}
      </div>
    </>
  );
}
