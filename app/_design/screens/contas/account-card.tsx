import Link from "next/link";
import { contagem } from "../../lib/plural";
import { ICONS, Icon } from "../../kit/icons";
import { useDesign } from "../../kit/context";
import { Cap, Panel } from "../../kit/primitives";
import { ActionLink, ContaLogo, StatusPill, balanceInk } from "./ui-primitives";
import { fmtBrl } from "@/src/domain/formato-de-resultado";
import type { ContasData } from "../../action-contracts";
import type { ContaAccount, ContasViewProps } from "./list-view";

export function AccountCard({ A, a, live, openMov, soonToast }: Pick<ContasViewProps, "live" | "openMov" | "soonToast"> & {
  A: ContasData;
  a: ContaAccount;
}) {
  const { T, numFont, ink } = useDesign();
  return (
    <Panel pad={20} style={{ display: 'flex', flexDirection: 'column', opacity: a.status === 'encerrada' ? 0.72 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 13 }}>
        <ContaLogo a={a} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: T.font.display, fontSize: 17, fontWeight: 600, color: T.text, letterSpacing: '-0.01em' }}>{a.name}</span>
            <span style={{ marginLeft: 'auto' }}><StatusPill s={a.status} /></span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 12, color: T.textMuted }}>
            <Icon d={ICONS.user} s={13} style={{ color: T.textFaint }} />{a.titular || A.owner.name}
          </div>
          <div style={{ fontSize: 11.5, color: T.textFaint, marginTop: 3 }}>{a.bankroll ? `↳ ${a.bankroll}` : 'sem tipster vinculado'}</div>
        </div>
      </div>
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${T.borderSoft}` }}>
        <Cap style={{ fontSize: 9.5, marginBottom: 6 }}>Saldo atual</Cap>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ ...numFont, fontSize: 26, fontWeight: 600, color: balanceInk(T, a.balance), letterSpacing: '-0.02em' }}>{fmtBrl(a.balance)}</span>
          <span style={{ ...numFont, fontSize: 12.5, fontWeight: 600, color: ink(a.betProfit ?? a.profit) }}>{fmtBrl(a.betProfit ?? a.profit, true)}</span>
        </div>
        <div style={{ fontSize: 11.5, color: T.textFaint, marginTop: 5 }}>{contagem(a.bets, 'aposta')} vinculadas · atualizado {a.last}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 16, paddingTop: 14, borderTop: `1px solid ${T.borderSoft}`, flexWrap: 'wrap' }}>
        <ActionLink soon={!live} icon={ICONS.arrowDown} onClick={() => live ? openMov(a.id, 'DEPOSITO') : soonToast('Depósito')}>Depósito</ActionLink>
        <ActionLink soon={!live} icon={ICONS.arrowUp} onClick={() => live ? openMov(a.id, 'SAQUE') : soonToast('Saque')}>Saque</ActionLink>
        <Link href={'/contas?acc=' + a.id} style={{ marginLeft: 'auto', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: T.font.body, fontSize: 13, fontWeight: 600, color: T.accent }}>Ver detalhes<Icon d={ICONS.arrow} s={14} /></Link>
      </div>
    </Panel>
  );
}
