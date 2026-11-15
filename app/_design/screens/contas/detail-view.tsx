import Link from "next/link";
import { uiDisplayColor, uiHexA } from "../../utils";
import { porFaixa } from "../../kit/faixas";
import { ICONS, Icon } from "../../kit/icons";
import { useDesign } from "../../kit/context";
import { Cap, Panel } from "../../kit/primitives";
import { ActionLink, ContaLogo, StatusPill, balanceInk } from "./ui-primitives";
import { fmtBrl } from "@/src/domain/formato-de-resultado";
import type { MoveType } from "../../adapters/contas";
import type { Theme } from "../../theme";
import type { ContaAccount, ContasViewProps } from "./list-view";

const typeMeta: Record<MoveType, readonly [string, string, string]> = { aporte: ['Aporte', 'pos', ICONS.arrowDown], saque: ['Saque', 'neg', ICONS.arrowUp], resultado: ['Resultado', 'accent', ICONS.check], bonus: ['Bônus', 'pos', ICONS.gift] };
const toneColor = (T: Theme, tone: string) => tone === 'neg' ? T.neg : tone === 'accent' ? T.accent : tone === 'pos' ? T.pos : T.textMuted;

export function ContasDetailView({ A, detail, live, canManage, onAct }: Pick<ContasViewProps, "A" | "live" | "canManage"> & {
  detail: ContaAccount;
  onAct: (label: string, a: ContaAccount) => void;
}) {
  const { T, numFont, ink } = useDesign();
  const a = detail;
  const moveCount = a.moveCount;
  const kpis = [
    { k: 'Saldo atual', v: fmtBrl(a.balance), c: balanceInk(T, a.balance), sub: `atualizado ${a.last}` },
    { k: 'Total depositado', v: fmtBrl(a.deposited), c: T.text, sub: `aberta em ${a.opened}` },
    { k: 'Total sacado', v: fmtBrl(a.withdrawn), c: T.text, sub: 'realizados' },
    { k: 'Resultado de apostas', v: fmtBrl(a.betProfit ?? 0, true), c: ink(a.betProfit ?? 0), sub: 'ganhos − perdas − estornos' },
    { k: 'Lucro de caixa', v: fmtBrl(a.profit, true), c: ink(a.profit), sub: 'saldo + saques − depósitos' },
  ];
  const acts: [string, string, string][] = [['Depósito', ICONS.arrowDown, 'pos'], ['Saque', ICONS.arrowUp, ''], ['Bônus', ICONS.gift, ''], ['Ajuste', ICONS.tune, ''], [a.status === 'limitada' ? 'Reativar' : 'Limitar', ICONS.ban, 'accent'], ['Editar', ICONS.edit, ''], ['Excluir', ICONS.trash, 'neg']];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, rowGap: 14, flexWrap: 'wrap', marginBottom: 26 }}>
        <Link href="/contas" aria-label="Voltar para contas" title="Voltar para contas" style={{ marginTop: 4, display: 'grid', placeItems: 'center', width: 44, height: 44, borderRadius: T.radiusSm, border: `1px solid ${T.border}`, color: T.textMuted, textDecoration: 'none', flexShrink: 0 }}><Icon d={ICONS.back} s={18} /></Link>
        <ContaLogo a={a} s={52} />
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <h1 style={{ margin: 0, fontFamily: T.font.display, fontSize: 28, fontWeight: T.displayWeight, letterSpacing: T.displaySpacing, color: T.text, lineHeight: 1 }}>{a.name}</h1>
            <StatusPill s={a.status} big />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 6, fontFamily: T.font.body, fontSize: 13.5, color: T.textMuted, flexWrap: 'wrap' }}>
            <Icon d={ICONS.user} s={14} style={{ color: T.textFaint }} /><span>{a.titular || A.owner.name}</span>
            <span style={{ color: T.textFaint }}>·</span><span>{a.bankroll ? a.bankroll : 'sem tipster'}</span>
          </div>
        </div>
        {canManage ? <div style={{ marginLeft: 'auto', display: 'flex', gap: 18, flexWrap: 'wrap', paddingTop: 6 }}>
          {acts.map(([l, ic, tone]) => <ActionLink key={l} soon={!live} icon={ic} tone={tone} onClick={() => onAct(l, a)}>{l}</ActionLink>)}
        </div> : null}
      </div>
      <div {...porFaixa({ display: 'grid', gap: 16, marginBottom: 22 }, { gridTemplateColumns: { largo: 'repeat(4,1fr)', medio: 'repeat(2,1fr)' } })}>
        {kpis.map((m) => (
          <Panel key={m.k} pad={20}>
            <Cap style={{ marginBottom: 12 }}>{m.k}</Cap>
            <div style={{ ...numFont, fontSize: 24, fontWeight: 600, color: uiDisplayColor(T, m.c), letterSpacing: '-0.02em', lineHeight: 1.05, whiteSpace: 'nowrap' }}>{m.v}</div>
            <div style={{ fontSize: 11, color: T.textFaint, marginTop: 9 }}>{m.sub}</div>
          </Panel>
        ))}
      </div>
      {a.status === 'limitada' && <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '13px 18px', marginBottom: 22, borderRadius: T.radiusMd, background: T.negSoft, border: `1px solid ${uiHexA(T.neg, 0.25)}`, fontFamily: T.font.body, fontSize: 13.5, color: T.text }}>
        <Icon d={ICONS.ban} s={17} style={{ color: T.neg, flexShrink: 0 }} /><span>Conta <b>limitada pela casa</b>{a.limitedAt ? <> em {a.limitedAt}</> : null}. {fmtBrl(a.balance)} ainda retidos — sacar assim que possível.</span></div>}
      <Panel pad={0} style={{ overflow: 'hidden' }}>
        <div style={{ padding: '20px 24px 14px' }}>
          <h3 style={{ margin: 0, fontFamily: T.font.display, fontSize: 17, fontWeight: 600, color: T.text, letterSpacing: '-0.01em' }}>Histórico de movimentações</h3>
          <div style={{ fontSize: 12, color: T.textFaint, marginTop: 3 }}>{moveCount} registros nesta conta{moveCount > a.moves.length ? ` · exibindo os ${a.moves.length} mais recentes` : ''}</div>
        </div>
        {a.moves.map((l) => {
          const [lbl, tone, icon] = typeMeta[l.type];
          const c = toneColor(T, tone);
          return (
            <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 24px', borderTop: `1px solid ${T.borderSoft}` }}>
              <span style={{ width: 32, height: 32, borderRadius: T.radiusSm, background: uiHexA(c, 0.12), color: c, display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon d={icon} s={15} w={1.9} /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: T.font.body, fontSize: 13.5, fontWeight: 600, color: T.text }}>{l.desc}</div>
                <div style={{ fontSize: 11.5, color: T.textMuted, marginTop: 2 }}><span style={{ color: c, fontWeight: 600 }}>{lbl}</span> <span style={{ color: T.textFaint }}>·</span> <span style={numFont}>{l.date}</span>{l.betId ? <> <span style={{ color: T.textFaint }}>·</span> <Link href={`/aposta?id=${l.betId}`} prefetch={false} style={{ color: T.accent, textDecoration: 'none' }}>aposta</Link></> : null}</div>
              </div>
              {l.value !== 0 && <span style={{ ...numFont, fontSize: 14.5, fontWeight: 600, color: ink(l.value), flexShrink: 0, whiteSpace: 'nowrap' }}>{fmtBrl(l.value, true)}</span>}
            </div>
          );
        })}
        <div style={{ height: 12 }} />
      </Panel>
    </div>
  );
}
