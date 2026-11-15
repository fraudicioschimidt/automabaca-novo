import type { AnalyzerPeriod, AnalyzerQuery } from "@/src/domain/analyzer-query";
import { AnalyzerFilters } from "./server-controls";
import { textoDaJanela } from "../../lib/analyzer-range";
import { plural } from "../../lib/plural";
import { useDesign } from "../../kit/context";
import { Cap } from "../../kit/primitives";
import { AnalyzerCard } from "./ui-primitives";

/**
 * O recorte declara o nome E a extensão: sem ela, em `Tudo` o operador lia um
 * ROI sem saber de que período. A janela vem da MESMA regra que filtra
 * (`analyzer-range`), e o cartão diz o eixo: o dia do jogo, não o da liquidação.
 */
export function PeriodCard({
  range, setRange, todayKey, FB, janela,
  janelaAnterior, rotuloAnterior, query = null, onQueryChange = null, pending = false, totalCount = null, futurePending = 0,
}: {
  range: AnalyzerPeriod;
  setRange: (range: AnalyzerPeriod) => void;
  todayKey: string;
  FB: readonly unknown[];
  janela: Parameters<typeof textoDaJanela>[0];
  janelaAnterior: string | null;
  rotuloAnterior: string | null;
  query?: AnalyzerQuery | null;
  onQueryChange?: ((change: Partial<AnalyzerQuery>) => void) | null;
  pending?: boolean;
  totalCount?: number | null;
  /** Pendentes de jogo depois de hoje que o recorte com prazo inclui. */
  futurePending?: number;
}) {
  const { T, numFont } = useDesign();
  const extensao = textoDaJanela(janela);
  return (
    <AnalyzerCard pad={20} style={{ marginBottom: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <Cap style={{ fontSize: 10 }}>Período</Cap>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {([['tudo', 'Tudo'], ['90d', 'Últimos 90 dias'], ['30d', 'Últimos 30 dias'], ['7d', 'Últimos 7 dias'], ['hoje', 'Hoje (' + todayKey.slice(8, 10) + '/' + todayKey.slice(5, 7) + ')']] satisfies Array<[AnalyzerPeriod, string]>).map(([k, l]) => {
            const on = range === k;
            return (<button key={k} disabled={pending} aria-pressed={on} onClick={() => setRange(k)} style={{ fontFamily: T.font.body, fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: '8px 14px', borderRadius: T.radiusSm, border: 'none', background: on ? T.text : T.surface2, color: on ? T.surface : T.textMuted }}>{l}</button>);
          })}
        </div>
        <div style={{ marginLeft: 'auto', textAlign: 'right', fontFamily: T.font.body, fontSize: 13, color: T.textFaint }}>
          <div>
            {extensao && <><b style={{ ...numFont, color: T.textMuted }}>{extensao}</b> <span>·</span> </>}
            <b style={{ ...numFont, color: T.textMuted }}>{totalCount ?? FB.length}</b> apostas no recorte <span>·</span> pelo dia do jogo</div>
          {futurePending > 0 && (
            <div style={{ ...T.type?.caption, fontSize: 12, marginTop: 3 }}>
              inclui <b style={{ ...numFont }}>{futurePending}</b> {plural(futurePending, "pendente")} de jogos futuros
            </div>
          )}
          {/* A régua do comparativo, uma vez só: os ~20 deltas dos KPIs já
              nomeiam contra o que comparam ("vs os 7 dias anteriores"), e
              repetir a data em cada um seria ruído. */}
          {janelaAnterior && (
            <div style={{ ...T.type?.caption, fontSize: 12, marginTop: 3 }}>
              compara com {rotuloAnterior} <b style={{ ...numFont }}>{janelaAnterior}</b>
            </div>
          )}
        </div>
      </div>
      {query && onQueryChange && <AnalyzerFilters query={query} onChange={onQueryChange} pending={pending} />}
    </AnalyzerCard>
  );
}
