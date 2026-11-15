"use client";
// Config: bancas, taxonomia de mercados, times, jogadores e sessões.
import { useState } from "react";
import { AppSidebar } from "../AppSidebar";
import { AppShell } from "../kit/primitives";
import type { ConfigScreenProps } from "../screen-types";
import { ConfigHeader } from "./config/bancas-card";
import { ConfigSections } from "./config/sections";
import { ConfigModals } from "./config/modals";
import { useBancas } from "./config/use-bancas";
import { useMarkets } from "./config/use-markets";
import { useTeamCards } from "./config/use-team-cards";

/**
 * Sem as actions (?mock=1) cada mudança vale só na tela; com elas, o estado
 * local acompanha o servidor (otimista onde desfazer é seguro).
 */
export function ConfigScreen({ data, canManage = true, ...actions }: ConfigScreenProps) {
  const bancas = useBancas(data.bancas, canManage, actions);
  const mercados = useMarkets(data.markets, actions);
  const times = useTeamCards(data, actions);
  // Bancas primeiro: é o que o operador abre para cadastrar canal, e é o
  // destino do "Novo bankroll" (/config?nova=1). A seção mora aqui porque o
  // "Nova banca" do cabeçalho precisa trazê-la de volta de qualquer outra.
  const [secao, setSecao] = useState('bancas');
  const openNewBankroll = () => {
    setSecao('bancas');
    bancas.lista.setAdding(true);
  };

  return (
    <AppShell sidebar={<AppSidebar active="Config" />}>
      <div className="app-main" style={{ flex: 1, minWidth: 0, padding: '46px', maxWidth: 1180, margin: '0 auto' }}>
        <ConfigHeader canManage={canManage} onNewBanca={openNewBankroll} />
        <ConfigSections canManage={canManage} data={data} bancas={bancas.lista} mercados={mercados} times={times} acoes={actions}
          secao={secao} onSelectSection={setSecao} />
        <div style={{ height: 20 }} />
      </div>
      {canManage ? <ConfigModals {...bancas.modal} /> : null}
    </AppShell>
  );
}
