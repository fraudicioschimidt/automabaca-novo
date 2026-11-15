import type { KeyboardEvent } from "react";
import Link from "next/link";
import type { AnalyzerScreenProps } from "../../screen-types";
import { FrescorDosDados } from "../../kit/FrescorDosDados";
import { ICONS, Icon } from "../../kit/icons";
import { useDesign } from "../../kit/context";
import { porFaixa } from "../../kit/faixas";
import { BankrollLogo } from "../../kit/primitives";

const TABS = [['overview', 'Visão geral'], ['clv', 'CLV'], ['steam', 'Abertura e linha'], ['timing', 'Momento'],
  ['liquidez', 'Liquidez'], ['segmentos', 'Segmentos'], ['casas', 'Casas'], ['periodo', 'Período'], ['simulador', 'Simulador']] as const;

export type AnalyzerTab = (typeof TABS)[number][0];

/** Ids compartilhados entre a aba e o painel que ela controla. */
export const tabButtonId = (k: AnalyzerTab) => `analyzer-tab-${k}`;
export const tabPanelId = (k: AnalyzerTab) => `analyzer-panel-${k}`;

/**
 * Setas/Home/End andam pela tablist (ativação automática, como o resto do
 * painel: selecionar É navegar). Tab continua saindo da lista para o painel.
 */
function onTabKeyDown(tab: AnalyzerTab, setTab: (tab: AnalyzerTab) => void) {
  return (event: KeyboardEvent<HTMLDivElement>) => {
    const passos: Partial<Record<string, number>> = { ArrowRight: 1, ArrowLeft: -1 };
    const passo = passos[event.key];
    const atual = TABS.findIndex(([k]) => k === tab);
    if (atual < 0) return;
    let alvo = -1;
    if (passo !== undefined) alvo = (atual + passo + TABS.length) % TABS.length;
    else if (event.key === "Home") alvo = 0;
    else if (event.key === "End") alvo = TABS.length - 1;
    if (alvo < 0) return;
    event.preventDefault();
    const [chave] = TABS[alvo]!;
    setTab(chave);
    // O foco acompanha a seleção; o botão só existe depois do re-render.
    requestAnimationFrame(() => document.getElementById(tabButtonId(chave))?.focus());
  };
}

export function AnalyzerHeader({ tab, setTab, data, slug, bkId, bkName }: {
  tab: AnalyzerTab;
  setTab: (tab: AnalyzerTab) => void;
  data: AnalyzerScreenProps["data"];
  slug: string | null;
  bkId: string | null;
  bkName: string;
}) {
  const { T } = useDesign();
  const portfolio = data?.scope === 'portfolio';
  const voltar = portfolio ? 'Voltar para os tipsters' : 'Voltar para o tipster';
  const destino = portfolio ? '/tipsters'
    : data ? ('/tipsters/' + slug) : ('/tipsters/' + (bkId || 'main') + (bkId ? '?bk=' + bkId : ''));
  return (
    <div>
      <div {...porFaixa({ display: 'flex', alignItems: 'center', marginBottom: 22 }, { gap: { largo: 16, compacto: 10 } })}>
        <Link href={destino} aria-label={voltar} title={voltar} {...porFaixa({ marginTop: 0, display: 'grid', placeItems: 'center',
          borderRadius: T.radiusSm, border: `1px solid ${T.border}`, background: 'transparent', color: T.textMuted,
          textDecoration: 'none', flexShrink: 0 }, { width: { largo: 38, compacto: 44 }, height: { largo: 38, compacto: 44 } })}><Icon d={ICONS.back} s={18} /></Link>
        <BankrollLogo name={data ? data.bk.name : bkName} logoUrl={data?.bk.logoUrl} toneKey={data?.bk.slug ?? null} s={{ largo: 52, compacto: 44 }} />
        <div style={{ minWidth: 0 }}>
          <h1 {...porFaixa({ margin: 0, fontFamily: T.font.display, fontWeight: T.displayWeight,
            letterSpacing: T.displaySpacing, color: T.text, lineHeight: 1.05 }, { fontSize: { largo: 30, compacto: 22 } })}>Analyzer <span style={{ color: T.textFaint, fontWeight: 400 }}>· {bkName}</span></h1>
          <div {...porFaixa({ fontFamily: T.font.body, color: T.textMuted, marginTop: 5 }, { fontSize: { largo: 14, compacto: 12.5 } })}>
            {portfolio
              ? 'Todos os tipsters juntos, em reais pelo valor da unidade de cada aposta.'
              : 'Leitura consolidada de edge, execução e variância do tipster.'}
          </div>
          {data?.frescor?.length ? (
            <div style={{ marginTop: 4 }}><FrescorDosDados fontes={data.frescor} /></div>
          ) : null}
        </div>
      </div>
      <div className="no-scrollbar" role="tablist" aria-label={portfolio ? 'Análises da carteira' : 'Análises do tipster'} onKeyDown={onTabKeyDown(tab, setTab)} style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${T.border}`, marginBottom: 24, overflowX: 'auto' }}>
        {TABS.map(([k, l]) => {
          const on = tab === k;
          return (
            // Padrão WAI-ARIA de abas: só a aba ATIVA fica no fluxo do Tab
            // (tabIndex 0) e as setas andam entre elas — sem isso o teclado
            // atravessava as abas uma a uma antes de chegar no conteúdo.
            // `aria-controls` só na ativa: o painel das outras não está
            // renderizado, e apontar para id inexistente é atributo inválido.
            <button key={k} id={tabButtonId(k)} role="tab" aria-selected={on} tabIndex={on ? 0 : -1}
              aria-controls={on ? tabPanelId(k) : undefined} onClick={() => setTab(k)}
              style={{ fontFamily: T.font.body, fontSize: 14, fontWeight: on ? 600 : 500,
              cursor: 'pointer', padding: '11px 14px', border: 'none', background: 'transparent', whiteSpace: 'nowrap',
              color: on ? T.text : T.textMuted, borderBottom: `2px solid ${on ? T.accent : 'transparent'}`, marginBottom: -1,
              letterSpacing: '-0.01em' }}>{l}</button>
          );
        })}
      </div>
    </div>
  );
}
