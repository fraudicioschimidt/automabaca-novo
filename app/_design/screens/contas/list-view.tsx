import { uiDisplayColor, uiHexA } from "../../utils";
import { AccountCard } from "./account-card";
import { Cap, Panel, ProductEmptyState } from "../../kit/primitives";
import { groupAccountsByOwner } from "../../lib/account-owner-groups";
import { contagem } from "../../lib/plural";
import { ICONS, Icon } from "../../kit/icons";
import { useDesign } from "../../kit/context";
import { porFaixa } from "../../kit/faixas";
import { balanceInk } from "./ui-primitives";
import { fmtBrl } from "@/src/domain/formato-de-resultado";
import type { Dispatch, SetStateAction } from "react";
import type { ContasData } from "../../action-contracts";
import type { ContaOverlay } from "./overlays";

export type ContaAccount = ContasData["accounts"][number];
export type MovTipo = Extract<ContaOverlay, { kind: "mov" }>["tipo"];
export type GroupMode = "status" | "owner";

/** O que a lista e o detalhe recebem da tela. */
export type ContasViewProps = {
  A: ContasData;
  live: boolean;
  canManage: boolean;
  openMov: (accId: string, tipo: MovTipo) => void;
  soonToast: (label: string) => void;
  groupMode: GroupMode;
  setGroupMode: Dispatch<SetStateAction<GroupMode>>;
};

export function ContasListView({ A, live, canManage, openMov, openConta, soonToast, groupMode, setGroupMode }: ContasViewProps & {
  openConta: (a: ContaAccount | null) => void;
}) {
  const { T, numFont, ink } = useDesign();
  const tiles = [
    { k: 'Ativas', v: String(A.summary.ativas), c: T.pos, sub: `${fmtBrl(A.summary.saldoAtivas)} em saldo` },
    { k: 'Limitadas', v: String(A.summary.limitadas), c: A.summary.limitadas ? T.neg : T.text, sub: `${fmtBrl(A.summary.retido)} retido` },
    { k: 'Encerradas', v: String(A.summary.encerradas), c: T.textMuted, sub: 'fora da operação' },
    { k: 'Saldo geral', v: fmtBrl(A.summary.saldo), c: balanceInk(T, A.summary.saldo), sub: `${contagem(A.accounts.length, 'conta')} no total`, mono: true },
  ];
  const statusGroups: { label: string; accounts: ContaAccount[]; summary?: undefined }[] = [
    { label: 'Contas ativas', accounts: A.accounts.filter((a) => a.status === 'ativa') },
    { label: 'Limitadas', accounts: A.accounts.filter((a) => a.status === 'limitada') },
    { label: 'Encerradas', accounts: A.accounts.filter((a) => a.status === 'encerrada') },
  ];
  const ownerGroups = groupAccountsByOwner(A.accounts, A.owner.name || 'Sem titular')
    .map((group) => ({ label: group.owner, accounts: group.accounts, summary: group }));
  const groups = groupMode === 'owner' ? ownerGroups : statusGroups;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, rowGap: 14, flexWrap: 'wrap', marginBottom: 26 }}>
        <div>
          <h1 style={{ margin: 0, fontFamily: T.font.display, fontSize: 32, fontWeight: T.displayWeight, letterSpacing: T.displaySpacing, color: T.text, lineHeight: 1.05 }}>Contas</h1>
          <div style={{ fontFamily: T.font.body, fontSize: 14, color: T.textMuted, marginTop: 6 }}>Saldos, limites e vínculos por casa. As movimentações ficam dentro de cada conta.</div>
        </div>
        {canManage ? <button title={live ? undefined : 'Em breve'} onClick={() => live ? openConta(null) : soonToast('Nova conta')} style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontFamily: T.font.body, fontSize: 14, fontWeight: 600, padding: '11px 18px', borderRadius: T.radiusMd, border: 'none', background: T.accent, color: T.accentText, boxShadow: `0 8px 20px -8px ${uiHexA(T.accent, 0.55)}`, whiteSpace: 'nowrap', opacity: live ? 1 : 0.5 }}>
          <Icon d={ICONS.plus} s={17} />Nova conta</button> : null}
      </div>
      <div {...porFaixa({ display: 'grid', gap: 16, marginBottom: 30 }, { gridTemplateColumns: { largo: 'repeat(4,1fr)', medio: 'repeat(2,1fr)' } })}>
        {tiles.map((m) => (
          <Panel key={m.k} pad={20}>
            <Cap style={{ marginBottom: 12 }}>{m.k}</Cap>
            <div style={{ ...numFont, fontFamily: T.font.num, fontSize: m.mono ? 22 : 30, fontWeight: 600, color: uiDisplayColor(T, m.c), letterSpacing: '-0.02em', lineHeight: 1.05, whiteSpace: 'nowrap' }}>{m.v}</div>
            <div style={{ fontSize: 11.5, color: T.textFaint, marginTop: 9 }}>{m.sub}</div>
          </Panel>
        ))}
      </div>
      {A.accounts.length > 0 ? (
        <div role="group" aria-label="Agrupar contas" style={{ display: 'inline-flex', padding: 3, marginBottom: 22, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, background: T.surface2 }}>
          {([['status', 'Por status'], ['owner', 'Por titular']] satisfies [GroupMode, string][]).map(([value, label]) => {
            const active = groupMode === value;
            return <button key={value} type="button" aria-pressed={active} onClick={() => setGroupMode(value)}
              style={{ minHeight: 38, padding: '8px 13px', border: 'none', borderRadius: Math.max(4, T.radiusSm - 3), cursor: 'pointer', fontFamily: T.font.body, fontSize: 12.5, fontWeight: active ? 600 : 500, color: active ? T.text : T.textMuted, background: active ? T.surface : 'transparent' }}>
              {label}
            </button>;
          })}
        </div>
      ) : null}
      {A.accounts.length === 0 && (
        <Panel pad={0} style={{ overflow: 'hidden' }}>
          <ProductEmptyState minHeight={{ largo: 280, medio: 240 }} titleSize={{ largo: 22, medio: 20 }} padding={{ largo: '40px', medio: '30px 22px' }}
            title="Adicione sua primeira conta"
            description="Centralize saldos, depósitos, saques e vínculos com seus tipsters em um só lugar."
            icon={
              <div aria-hidden="true" style={{ width: 58, height: 58, margin: '0 auto 18px', display: 'grid', placeItems: 'center', borderRadius: T.radius, color: T.brandAccent || T.accent, background: T.accentSoft, border: `1px solid ${uiHexA(T.brandAccent || T.accent, 0.28)}` }}>
                <Icon d={ICONS.bank} s={25} />
              </div>
            }
            action={canManage ? (
              <button onClick={() => live ? openConta(null) : soonToast('Nova conta')} style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 17px', border: 'none', borderRadius: T.radiusMd, background: T.accent, color: T.accentText, boxShadow: `0 8px 20px -8px ${uiHexA(T.accent, 0.55)}`, cursor: 'pointer', fontFamily: T.font.body, fontSize: 13.5, fontWeight: 600 }}>
                <Icon d={ICONS.plus} s={16} />Criar primeira conta
              </button>
            ) : null}
          />
        </Panel>
      )}
      {groups.map((group) => group.accounts.length > 0 && (
        <div key={group.label} style={{ marginBottom: 28 }}>
          <Cap style={{ marginBottom: group.summary ? 8 : 14 }}>{group.label} · {group.accounts.length}</Cap>
          {group.summary ? <div aria-label={`Subtotais de ${group.label}`} style={{ display: 'flex', gap: 16, rowGap: 6, flexWrap: 'wrap', marginBottom: 14, fontFamily: T.font.body, fontSize: 12, color: T.textMuted }}>
            <span>Saldo <b style={{ ...numFont, color: balanceInk(T, group.summary.balance) }}>{fmtBrl(group.summary.balance)}</b></span>
            <span>Apostas <b style={{ ...numFont, color: ink(group.summary.betProfit) }}>{fmtBrl(group.summary.betProfit, true)}</b></span>
            <span>Caixa <b style={{ ...numFont, color: ink(group.summary.profit) }}>{fmtBrl(group.summary.profit, true)}</b></span>
            <span>Depositado <b style={{ ...numFont, color: T.text }}>{fmtBrl(group.summary.deposited)}</b></span>
            <span>Sacado <b style={{ ...numFont, color: T.text }}>{fmtBrl(group.summary.withdrawn)}</b></span>
          </div> : null}
          <div {...porFaixa({ display: 'grid', gap: 16 }, { gridTemplateColumns: { largo: 'repeat(3,1fr)', medio: 'repeat(1,1fr)' } })}>
            {group.accounts.map((a) => (
              <AccountCard key={a.id} A={A} a={a} live={live} openMov={openMov} soonToast={soonToast} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
