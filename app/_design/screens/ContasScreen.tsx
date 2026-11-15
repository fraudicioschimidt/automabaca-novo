"use client";
// Contas: lista de casas (cartões) + detalhe por conta com movimentações.
import { useState } from "react";
import { AppSidebar } from "../AppSidebar";
import { AppShell } from "../kit/primitives";
import { porFaixa } from "../kit/faixas";
import { ContasListView } from "./contas/list-view";
import { ContasDetailView } from "./contas/detail-view";
import { ContasOverlays, type ContaForm, type ContaOverlay } from "./contas/overlays";
import { errorMessage, toast } from "../toast";
import type { ContasScreenProps } from "../screen-types";
import type { ContaActionResult } from "@/app/(painel)/contas/actions";
import type { ContaAccount, GroupMode, MovTipo } from "./contas/list-view";

export function ContasScreen({ data: A, accId = null, canManage = true, onRefresh = null, onMovimentar = null, onCriar = null, onEditar = null, onStatus = null, onRemover = null }: ContasScreenProps) {
  const accSel = accId || ((typeof location !== 'undefined') ? new URLSearchParams(location.search).get('acc') : null);
  const detail = A.accounts.find((a) => a.id === accSel) || null;

  const live = !!onCriar;
  const [ov, setOv] = useState<ContaOverlay | null>(null);
  const [form, setForm] = useState<ContaForm>({});
  const [bkQuery, setBkQuery] = useState('');
  const [pend, setPend] = useState(false);
  const [groupMode, setGroupMode] = useState<GroupMode>('status');
  const closeOv = () => { if (!pend) { setOv(null); setForm({}); setBkQuery(''); } };
  // Recusa de negócio chega como `{ ok: false, erro }`: server action que
  // LANÇA perde a mensagem em produção. O `catch` fica para exceção de verdade
  // (rede, sessão). Recusa mantém o overlay aberto, junto com o motivo.
  const run = async (fn: () => Promise<ContaActionResult>, okMsg: string) => {
    if (pend) return;
    setPend(true);
    try {
      const res = await fn();
      if (res && res.ok === false) {
        toast(res.erro || 'Operação recusada', 'warn');
        return;
      }
      toast(okMsg, 'ok');
      setOv(null);
      setForm({});
      // A resposta embutida da server action pode trazer os props anteriores
      // sob concorrência: relê o RSC para a lista não ficar velha.
      if (onRefresh) onRefresh();
    }
    catch (e) { toast(errorMessage(e, 'Falha na operação'), 'warn'); }
    finally { setPend(false); }
  };
  // A chave de idempotência nasce ao ABRIR o formulário e vive enquanto ele
  // estiver aberto: duplo clique reenvia a mesma e o servidor grava uma linha
  // só. O `run()` fecha o overlay no sucesso, então o próximo depósito — mesmo
  // idêntico — abre um formulário novo e ganha chave nova.
  const openMov = (accId2: string, tipo: MovTipo) => { setForm({ mutId: crypto.randomUUID() }); setOv({ kind: 'mov', accId: accId2, tipo }); };
  const openConta = (a: ContaAccount | null) => { setBkQuery(''); setForm(a ? { casa: a.name, titular: a.titular, apelido: a.apelido || '', bankrollIds: a.bankrollIds || [] } : { bankrollIds: [], mutId: crypto.randomUUID() }); setOv({ kind: 'conta', accId: a ? a.id : null }); };
  const toggleStatus = (a: ContaAccount) => {
    const current = a.status === 'limitada' ? 'LIMITADA' : a.status === 'encerrada' ? 'ENCERRADA' : 'ATIVA';
    const target = a.status === 'limitada' ? 'ATIVA' : 'LIMITADA';
    return run(() => onStatus!(a.id, current, target), a.status === 'limitada' ? 'Conta reativada' : 'Conta limitada');
  };
  const soonToast = (label: string) => { toast(label + ' — em breve', label === 'Excluir' ? 'warn' : 'info'); };
  const onAct = (label: string, a: ContaAccount) => {
    if (!live) return soonToast(label);
    if (label === 'Depósito') openMov(a.id, 'DEPOSITO');
    else if (label === 'Saque') openMov(a.id, 'SAQUE');
    else if (label === 'Bônus') openMov(a.id, 'BONUS');
    else if (label === 'Ajuste') openMov(a.id, 'AJUSTE_MANUAL');
    else if (label === 'Editar') openConta(a);
    else if (label === 'Excluir') setOv({ kind: 'excluir', accId: a.id });
    // `run` já avisa a falha no toast e não rejeita.
    else toggleStatus(a).catch(() => undefined);
  };
  const Sidebar = <AppSidebar active="Contas" />;
  const viewProps = { A, live, canManage, openMov, soonToast, groupMode, setGroupMode };

  return (
    <AppShell sidebar={Sidebar}>
      <div {...porFaixa({ flex: 1, minWidth: 0, maxWidth: 1180, margin: '0 auto' }, { padding: { largo: 46, medio: 26 } }, 'app-main')}>
        {detail
          ? <ContasDetailView {...viewProps} detail={detail} onAct={onAct} />
          : <ContasListView {...viewProps} openConta={openConta} />}
        <div style={{ height: 20 }} />
      </div>
      {canManage ? <ContasOverlays A={A} ov={ov} pend={pend} closeOv={closeOv} form={form} setForm={setForm}
        bkQuery={bkQuery} setBkQuery={setBkQuery} run={run} onMovimentar={onMovimentar} onCriar={onCriar} onEditar={onEditar} onRemover={onRemover} />
        : null}
    </AppShell>
  );
}
