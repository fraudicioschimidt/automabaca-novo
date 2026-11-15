import Link from "next/link";
import { fmtOdds, fmtUnit } from "@/src/domain/formato-de-resultado";
import { useDesign } from "../../kit/context";
import { previousResultText, removalOriginText } from "../../lib/removal-text";
import type { RemovedBet } from "./types";

/** Botão de texto: alvo de toque de 44px, como os outros da lista. */
const ACTION = { minHeight: 44, padding: '0 12px', display: 'inline-flex', alignItems: 'center' } as const;

/**
 * A aba "Removidas" do histórico: as apostas que saíram da banca (pelo 👎 no
 * canal ou pelo painel), com quando e por onde saíram, o que o estorno
 * desfez, a ficha e o "Restaurar". Sem a marca de restaurável (exclusão
 * anterior a ela), a aposta não volta pelo painel.
 */
export function RemovedBets({ bets, total, shown, searching, restoring, onRestore }: {
  bets: readonly RemovedBet[];
  /** Quantas a banca tem removidas; `shown` é quantas vieram, das mais recentes. */
  total: number;
  shown: number;
  searching: boolean;
  restoring: ReadonlySet<string>;
  onRestore: ((bet: RemovedBet) => void) | null;
}) {
  const { T, numFont } = useDesign();
  if (bets.length === 0) {
    return (
      <div style={{ padding: 50, textAlign: 'center', fontFamily: T.font.body, color: T.textFaint, fontSize: 14,
        borderTop: `1px solid ${T.borderSoft}` }}>
        {searching ? 'Nenhuma aposta removida corresponde à busca.' : 'Nenhuma aposta removida neste tipster.'}
      </div>
    );
  }
  const name = (b: RemovedBet) => b.away ? `${b.home} contra ${b.away}` : b.home;
  return (
    <ul aria-label="Apostas removidas" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {bets.map((b) => {
        const previous = previousResultText(b.removal.previous);
        const busy = restoring.has(b.id);
        return (
          <li key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 14, rowGap: 8, flexWrap: 'wrap',
            padding: '12px var(--bk-pad)', borderTop: `1px solid ${T.borderSoft}`, fontFamily: T.font.body }}>
            <div style={{ flex: '1 1 240px', minWidth: 0 }}>
              <div style={{ ...T.type.rowTitle, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {b.home}{b.away ? <> <span style={{ color: T.textFaint, fontWeight: 400 }}>vs</span> {b.away}</> : null}
              </div>
              <div style={{ fontSize: 12.5, color: T.textMuted, marginTop: 3 }}>
                {b.market} <b>{b.line}</b> <span style={{ color: T.textFaint }}>·</span> <span style={numFont}>@{fmtOdds(b.odds)} · {fmtUnit(b.stake)}</span>
              </div>
            </div>
            <div style={{ flex: '1 1 220px', minWidth: 0, fontSize: 12.5, color: T.textMuted, lineHeight: 1.5 }}>
              Removida {removalOriginText(b.removal.origin)} em <span style={numFont}>{b.removal.at}</span>
              {previous ? <><br />{previous.charAt(0).toUpperCase() + previous.slice(1)}</> : null}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
              <Link href={`/aposta?id=${b.id}`} aria-label={`Ficha de ${name(b)}`}
                style={{ ...ACTION, fontSize: 13, fontWeight: 600, color: T.accent, textDecoration: 'none' }}>Ficha</Link>
              {b.removal.restorable ? (onRestore ? (
                <button type="button" disabled={busy} onClick={() => onRestore(b)} aria-label={`Restaurar ${name(b)}`}
                  style={{ ...ACTION, borderRadius: T.radiusSm, border: `1px solid ${T.border}`, background: T.surface,
                    color: T.text, font: 'inherit', fontSize: 13, fontWeight: 600, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1 }}>
                  {busy ? 'Restaurando…' : 'Restaurar'}
                </button>
              ) : null) : (
                <span title="A exclusão não guardou o estado anterior da aposta." style={{ ...ACTION, fontSize: 12.5, color: T.textFaint }}>
                  Sem restauração
                </span>
              )}
            </div>
          </li>
        );
      })}
      {total > shown ? (
        <li style={{ padding: '12px var(--bk-pad)', borderTop: `1px solid ${T.borderSoft}`, fontFamily: T.font.body,
          fontSize: 12.5, color: T.textFaint }}>
          Mostrando as {shown} removidas mais recentes de {total}.
        </li>
      ) : null}
    </ul>
  );
}
