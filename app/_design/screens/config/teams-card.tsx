import { Fragment, useState, type CSSProperties, type ReactNode } from "react";
import { ModalForm } from "../../kit/ModalForm";
import { useDesign } from "../../kit/context";
import { porFaixa } from "../../kit/faixas";
import { ICONS, Icon } from "../../kit/icons";
import { sportLabel } from "../../lib/sport-options";
import { CardHead, ConfigCard, TextBtn } from "./ui-primitives";
import type { TeamCard, TipsterName } from "./types";
import type { TeamCardsState } from "./use-team-cards";

type TeamsCardProps = Omit<TeamCardsState, "inventory"> & { canManage: boolean };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Só para leitor de tela: o ✓ sozinho não diz nada a quem não vê. */
const SCREEN_READER_ONLY: CSSProperties = { position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 };

/** "Última busca: 12:37 · 184 jogos de hoje ligados · 2310 times com id do FlashScore". */
function PairingStatusLine({ status, stale }: Pick<TeamCardsState["pairing"], "status" | "stale">) {
  const { T } = useDesign();
  const notice = stale ? 'Busca ainda na fila — recarregue a tela mais tarde' : status.inProgress ? 'Busca em andamento' : null;
  const last = status.lastRound
    ? `${status.lastRound}${status.stoppedBy ? ` (parou: ${status.stoppedBy})` : ''}`
    : 'nenhuma registrada';
  return (
    <div role="status" aria-live="polite" style={{ ...T.type.caption, fontFamily: T.font.body, color: T.textMuted, padding: '12px var(--config-pad-x) 0' }}>
      {notice ? <span style={{ color: T.text, fontWeight: 600 }}>{notice} · </span> : null}
      Última busca: {last} · {plural(status.linkedToday, 'jogo de hoje ligado', 'jogos de hoje ligados')} · {plural(status.teamCards, 'time', 'times')} com id do FlashScore
    </div>
  );
}

/** Um ramo da ficha: o traço da árvore, o rótulo e o conteúdo, que quebra linha no celular. */
function Branch({ last, label, children }: { last: boolean; label: string; children: ReactNode }) {
  const { T, numFont } = useDesign();
  return (
    <>
      <span aria-hidden="true" style={{ ...numFont, color: T.textFaint, whiteSpace: 'pre' }}>{last ? '└─' : '├─'}</span>
      <div style={{ minWidth: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 6, rowGap: 6 }}>
        <span style={{ color: T.textMuted }}>{label}:</span>
        {children}
      </div>
    </>
  );
}

function TipsterChip({ name, onRemove }: { name: TipsterName; onRemove: (() => void) | null }) {
  const { T } = useDesign();
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6, ...T.type.captionSm, fontFamily: T.font.body,
      color: name.confirmed ? T.text : T.textMuted, background: T.surface2, border: `1px ${name.confirmed ? 'solid' : 'dashed'} ${T.border}`,
      borderRadius: T.pill, padding: onRemove ? '3px 6px 3px 10px' : '3px 10px', maxWidth: '100%' }}>
      <span style={{ overflowWrap: 'anywhere' }}>
        {name.name}
        {name.confirmed
          ? <span title="confirmado" style={{ color: T.pos, fontWeight: 700 }}> <span aria-hidden="true">✓</span><span style={SCREEN_READER_ONLY}>(confirmado)</span></span>
          : <span style={{ color: T.textFaint }}> (pendente)</span>}
      </span>
      {onRemove ? (
        <button type="button" onClick={onRemove} aria-label={`Remover o nome de tipster ${name.name}`} title="Remover este nome da ficha"
          onMouseEnter={(e) => { e.currentTarget.style.color = T.neg; }} onMouseLeave={(e) => { e.currentTarget.style.color = T.textFaint; }}
          style={{ display: 'grid', placeItems: 'center', width: 32, height: 32, margin: '-8px -6px -8px -4px', borderRadius: T.pill, border: 'none', background: 'transparent', color: T.textFaint, cursor: 'pointer', padding: 0, flexShrink: 0 }}>
          <Icon d={ICONS.close} s={11} w={2} /></button>
      ) : null}
    </span>
  );
}

/**
 * Uma ficha no formato de árvore:
 *
 *   Fenix · Uruguay · Segunda Division            id FS 8hWKNqzL
 *    ├─ Pinnacle: Fenix (12 jogos)
 *    ├─ FlashScore: Fenix
 *    └─ Tipsters: Atletico Fenix Montevideo ✓ · Fenix MVD (pendente)
 */
function TeamCardRow({ card, showSport, onRemoveName }: { card: TeamCard; showSport: boolean; onRemoveName: ((name: TipsterName) => void) | null }) {
  const { T, numFont } = useDesign();
  const place = [showSport ? sportLabel(card.sport) : null, card.country, card.league].filter(Boolean);
  // A categoria só aparece quando não é o time principal.
  const category = card.category !== 'principal' ? card.category : null;
  return (
    <li style={{ listStyle: 'none', padding: '15px var(--config-pad-x)', borderTop: `1px solid ${T.borderSoft}`, fontFamily: T.font.body }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 12, rowGap: 4 }}>
        <div style={{ minWidth: 0, flex: '1 1 240px' }}>
          <b style={{ ...T.type.rowTitle, fontWeight: 600, color: T.text, overflowWrap: 'anywhere' }}>{card.name}</b>
          {place.map((part) => (
            <Fragment key={part}><span style={{ color: T.textFaint }}> · </span><span style={{ ...T.type.caption, color: T.textMuted }}>{part}</span></Fragment>
          ))}
        </div>
        <span style={{ ...T.type.captionSm, color: T.textFaint, whiteSpace: 'nowrap' }}>
          id FS <span style={numFont}>{card.flashscoreTeamId}</span>
          {category ? <b style={{ fontWeight: 700, color: T.text }}> · {category}</b> : null}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', columnGap: 8, rowGap: 6, marginTop: 8, paddingLeft: 2, ...T.type.caption, color: T.text }}>
        <Branch last={false} label="Pinnacle">
          {card.pinnacleNames.length === 0 ? <span style={{ color: T.textFaint }}>nenhum jogo registrado</span> : card.pinnacleNames.map((name, i) => (
            <span key={name.name} style={{ overflowWrap: 'anywhere' }}>
              {i > 0 ? <span style={{ color: T.textFaint }}>· </span> : null}{name.name}{' '}
              <span style={{ color: T.textFaint }}>(<span style={numFont}>{name.games}</span> {name.games === 1 ? 'jogo' : 'jogos'})</span>
            </span>
          ))}
        </Branch>
        <Branch last={false} label="FlashScore"><span style={{ overflowWrap: 'anywhere' }}>{card.flashscoreName}</span></Branch>
        <Branch last label="Tipsters">
          {card.tipsterNames.length === 0 ? <span style={{ color: T.textFaint }}>nenhum nome ainda</span> : card.tipsterNames.map((name) => (
            <TipsterChip key={name.id} name={name} onRemove={onRemoveName ? () => onRemoveName(name) : null} />
          ))}
        </Branch>
      </div>
    </li>
  );
}

function RemoveTipsterNameDialog({ card, name, onClose, onRemove }: {
  card: TeamCard; name: TipsterName; onClose: () => void; onRemove: (cardId: string, nameId: string) => Promise<unknown>;
}) {
  const { T } = useDesign();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setPending(true); setError('');
    try { await onRemove(card.id, name.id); onClose(); }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : 'Não foi possível remover o nome.'); }
    finally { setPending(false); }
  };
  return (
    <ModalForm title="Remover nome de tipster" sub={`${name.name} → ${card.name}`} onClose={() => { if (!pending) onClose(); }}
      onSubmit={submit} pending={pending} submitLabel="Remover nome" submitTone="neg">
      <p style={{ margin: 0, color: T.textMuted, lineHeight: 1.6 }}>
        O nome sai desta ficha{name.confirmed ? ' e deixa de traduzir para este time' : ''}. Se um tipster voltar a usá-lo num jogo deste time, ele volta como pendente.
      </p>
      {error ? <p role="alert" style={{ margin: 0, color: T.neg }}>{error}</p> : null}
    </ModalForm>
  );
}

/**
 * Times: as fichas que o pareamento dos catálogos monta (id do FlashScore com os
 * nomes da Pinnacle17) e os nomes que os tipsters usaram para elas. A busca
 * acha por qualquer nome; a lista vem do servidor em páginas.
 */
export function TeamsCard({ cards, total, nextOffset, sports, query, setQuery, sport, setSport, loading, loadingMore, failed,
  loadMore, removeTipsterName, pairing, canManage }: TeamsCardProps) {
  const { T, numFont } = useDesign();
  const [removing, setRemoving] = useState<{ card: TeamCard; name: TipsterName } | null>(null);
  const searching = query.trim().length > 0 || sport !== null;
  const remaining = total - cards.length;

  return (
    <ConfigCard>
      <CardHead title="Times" sub="montados pela Pinnacle17 e pelo FlashScore" right={
        canManage ? <TextBtn onClick={pairing.request} disabled={pairing.requesting}>Buscar jogos agora</TextBtn> : null} />
      <PairingStatusLine status={pairing.status} stale={pairing.stale} />
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '14px var(--config-pad-x)', borderBottom: `1px solid ${T.borderSoft}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: T.surface2, border: `1px solid ${T.border}`, borderRadius: T.radiusMd, padding: '0 13px', flex: '1 1 240px', maxWidth: 420 }}>
          <Icon d={ICONS.search} s={16} style={{ color: T.textFaint }} />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Buscar time por qualquer nome" maxLength={100}
            placeholder="Buscar por nome (Pinnacle, FlashScore ou tipster)…"
            style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', padding: '10px 0', fontFamily: T.font.body, fontSize: 13.5, color: T.text }} />
        </div>
        {sports.length > 1 ? (
          <select value={sport ?? ''} onChange={(e) => setSport(e.target.value || null)} aria-label="Esporte"
            style={{ fontFamily: T.font.body, fontSize: 13.5, color: T.text, background: T.surface2, border: `1px solid ${T.border}`, borderRadius: T.radiusMd, padding: '9px 12px', minHeight: 40 }}>
            <option value="">Todos os esportes</option>
            {sports.map((option) => <option key={option.sport} value={option.sport}>{sportLabel(option.sport)} ({option.count})</option>)}
          </select>
        ) : null}
        <span role="status" aria-live="polite" style={{ ...T.type.captionSm, color: T.textFaint, marginLeft: 'auto' }}>
          {loading ? 'Buscando…' : <><span style={numFont}>{total}</span> {searching ? (total === 1 ? 'time encontrado' : 'times encontrados') : (total === 1 ? 'time' : 'times')}</>}
        </span>
      </div>
      {failed ? <div role="alert" style={{ padding: '12px var(--config-pad-x)', ...T.type.caption, color: T.neg }}>A busca falhou; a lista abaixo é a anterior.</div> : null}
      {cards.length === 0 && !loading ? (
        <div style={{ padding: '40px', textAlign: 'center', color: T.textFaint, fontSize: 14 }}>
          {searching ? `Nenhum time com "${query.trim()}".` : 'Nenhum time ainda. As fichas aparecem depois da primeira busca de jogos.'}
        </div>
      ) : (
        <ul aria-label="Times" aria-busy={loading} style={{ margin: 0, padding: 0, opacity: loading ? 0.6 : 1 }}>
          {cards.map((card) => (
            <TeamCardRow key={card.id} card={card} showSport={sports.length > 1}
              onRemoveName={canManage ? (name) => setRemoving({ card, name }) : null} />
          ))}
        </ul>
      )}
      {remaining > 0 && nextOffset !== null ? (
        <div {...porFaixa({ borderTop: `1px solid ${T.borderSoft}` }, { padding: { largo: '14px 26px 20px', compacto: '14px 18px 18px' } })}>
          <button type="button" onClick={loadMore} disabled={loadingMore || loading || failed}
            style={{ width: '100%', minHeight: 44, padding: '10px 14px', borderRadius: T.radiusSm, border: `1px solid ${T.border}`, background: T.surface2, color: T.textMuted, cursor: loadingMore ? 'default' : 'pointer', fontFamily: T.font.body, fontSize: 13, fontWeight: 600 }}>
            {loadingMore ? 'Carregando…' : `Mostrar mais · ${plural(remaining, 'restante', 'restantes')}`}
          </button>
        </div>
      ) : null}
      {removing && canManage ? (
        <RemoveTipsterNameDialog card={removing.card} name={removing.name} onClose={() => setRemoving(null)} onRemove={removeTipsterName} />
      ) : null}
    </ConfigCard>
  );
}
