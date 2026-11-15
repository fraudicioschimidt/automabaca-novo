import { useMemo, useState } from "react";
import { uiHexA } from "../../utils";
import { ICONS, Icon } from "../../kit/icons";
import { useDesign } from "../../kit/context";
import { CardHead, ConfigCard } from "./ui-primitives";
import type { MarketsState } from "./use-markets";

function AliasChip({ canon, alias, canManage, disabled, onRemove }: { canon: string; alias: string; canManage: boolean; disabled: boolean; onRemove: (canon: string, alias: string) => void }) {
  const { T } = useDesign();
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: T.font.body, fontSize: 13, fontWeight: 500,
      color: T.text, background: T.surface2, border: `1px solid ${T.border}`,
      padding: '6px 11px', borderRadius: T.pill, whiteSpace: 'nowrap' }}>
      {alias}
      {canManage && <button disabled={disabled} onClick={(e) => { e.stopPropagation(); onRemove(canon, alias); }} aria-label={`Remover alias ${alias} de ${canon}`} title={`Remover ${alias}`}
        onMouseEnter={(e) => { e.currentTarget.style.color = T.neg; }} onMouseLeave={(e) => { e.currentTarget.style.color = T.textFaint; }}
        style={{ display: 'grid', placeItems: 'center', width: 32, height: 32, margin: '-8px -8px -8px 0', borderRadius: T.pill, border: 'none', background: 'transparent', color: T.textFaint, cursor: 'pointer', padding: 0 }}><Icon d={ICONS.close} s={11} w={2} /></button>}
    </span>
  );
}

/**
 * Taxonomia de mercados: uma linha por mercado (nome + quantos aliases), o
 * conteúdo abre no clique e a lista rola dentro do card, que não cresce com a
 * taxonomia. A busca filtra e já abre o que encontra: quem procura um alias
 * quer vê-lo, não achar a linha.
 */
export function MarketsCard({ marketCount, pendingMarkets, mq, setMq, markets, addAlias, setAddAlias, commitAlias, removeAlias, canManage }: MarketsState & { marketCount: number; canManage: boolean }) {
  const { T } = useDesign();
  const [aberto, setAberto] = useState<string | null>(null);
  const buscando = mq.trim().length > 0;

  const filteredMarkets = useMemo(() => {
    const q = mq.trim().toLowerCase();
    if (!q) return markets;
    return markets.filter((m) => m.canon.toLowerCase().includes(q) || m.aliases.some((a) => a.toLowerCase().includes(q)));
  }, [markets, mq]);

  return (
    <ConfigCard style={{ marginBottom: 22 }}>
      <CardHead title="Mercados" sub={`${marketCount} labels Pinnacle · aliases Bet365 → canônico`} right={
        <span style={{ fontFamily: T.font.body, fontSize: 11.5, color: T.textFaint }}>aliases valem imediatamente</span>} />
      <div style={{ padding: '16px var(--config-pad-x)', borderBottom: `1px solid ${T.borderSoft}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: T.surface2, border: `1px solid ${T.border}`, borderRadius: T.radiusMd, padding: '0 13px', maxWidth: 360 }}>
          <Icon d={ICONS.search} s={16} style={{ color: T.textFaint }} />
          <input value={mq} onChange={(e) => setMq(e.target.value)} aria-label="Buscar mercado ou alias" placeholder="Buscar mercado ou alias…" style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', padding: '10px 0', fontFamily: T.font.body, fontSize: 13.5, color: T.text }} />
        </div>
      </div>

      {/* A altura corta uma linha PELA METADE de propósito: com o corte na
          borda de uma linha a lista parece terminar ali. Meia linha visível é
          o que diz "rola". */}
      <div style={{ maxHeight: 400, overflowY: 'auto' }}>
        {filteredMarkets.map((m, i) => {
          const expandido = buscando || aberto === m.canon;
          const editando = canManage && addAlias.canon === m.canon;
          return (
            <div key={m.canon} style={{ borderBottom: i < filteredMarkets.length - 1 ? `1px solid ${T.borderSoft}` : 'none' }}>
              <button
                type="button"
                onClick={() => setAberto(expandido && !buscando ? null : m.canon)}
                aria-expanded={expandido}
                onMouseEnter={(e) => { e.currentTarget.style.background = T.surface2; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', minHeight: 46,
                  padding: '11px var(--config-pad-x)', border: 'none', background: 'transparent', cursor: 'pointer',
                  textAlign: 'left', transition: `background ${T.motion.fast} ease` }}
              >
                <span style={{ display: 'grid', placeItems: 'center', width: 16, height: 16, flexShrink: 0, color: T.textFaint,
                  transform: expandido ? 'rotate(90deg)' : 'none', transition: `transform ${T.motion.fast} ease` }}>
                  <Icon d={ICONS.chevronRight} s={13} w={2} />
                </span>
                <span style={{ flex: 1, fontFamily: T.font.body, fontSize: 14, fontWeight: 600, color: T.text }}>{m.canon}</span>
                <span style={{ fontFamily: T.font.body, fontSize: 12, color: T.textFaint, whiteSpace: 'nowrap' }}>
                  {m.aliases.length === 0 ? 'sem alias' : `${m.aliases.length} alias${m.aliases.length === 1 ? '' : 'es'}`}
                </span>
              </button>
              {expandido ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '0 var(--config-pad-x) 16px calc(var(--config-pad-x) + 28px)' }}>
                  {m.aliases.map((a) => <AliasChip key={a} canon={m.canon} alias={a} canManage={canManage} disabled={pendingMarkets.has(m.canon)} onRemove={removeAlias} />)}
                  {editando ? (
                    <input disabled={pendingMarkets.has(m.canon)} autoFocus value={addAlias.val} onChange={(e) => setAddAlias((s) => ({ ...s, val: e.target.value }))}
                      onKeyDown={async (e) => { if (e.key === 'Enter') await commitAlias(m.canon); if (e.key === 'Escape') setAddAlias({ canon: null, val: '' }); }}
                      onBlur={() => commitAlias(m.canon)} placeholder="novo alias…"
                      style={{ fontFamily: T.font.body, fontSize: 13, color: T.text, background: T.surface, border: `1px solid ${T.accent}`, borderRadius: T.pill, padding: '6px 12px', outline: 'none', width: 150 }} />
                  ) : canManage ? (
                    <button disabled={pendingMarkets.has(m.canon)} onClick={() => setAddAlias({ canon: m.canon, val: '' })}
                      onMouseEnter={(e) => { e.currentTarget.style.borderColor = uiHexA(T.accent, 0.4); e.currentTarget.style.color = T.accent; }}
                      onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.textFaint; }}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: T.font.body, fontSize: 13, fontWeight: 500, color: T.textFaint, background: 'transparent', border: `1px dashed ${T.border}`, padding: '6px 11px', borderRadius: T.pill, cursor: 'pointer' }}>
                      <Icon d={ICONS.plus} s={12} w={2} />alias</button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
        {filteredMarkets.length === 0 && <div style={{ padding: 40, textAlign: 'center', color: T.textFaint, fontSize: 14 }}>Nenhum mercado corresponde a "{mq}".</div>}
      </div>
    </ConfigCard>
  );
}
