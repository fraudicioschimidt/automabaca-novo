import { createContext, use, type CSSProperties, type ReactNode } from "react";
import { UNITS_FORMAT, type MoneyFormat } from "@/src/domain/formato-de-resultado";
import { Icon } from "../../kit/icons";
import { useDesign } from "../../kit/context";
import { porFaixa } from "../../kit/faixas";

/**
 * Como o Analyzer escreve dinheiro: unidades na banca, reais na carteira. O
 * `AnalyzerScreen` decide pelo escopo do dado; abas, tabelas, gráficos e gaveta
 * leem daqui em vez de chamar `fmtU` direto.
 */
export const MoneyFormatContext = createContext<MoneyFormat>(UNITS_FORMAT);
export const useMoneyFormat = () => use(MoneyFormatContext);

/** O cartão do Analyzer: título/ícone/subtítulo opcionais; sem `pad`, o respiro é menor no compacto. */
export function AnalyzerCard({ title, sub, children, icon, pad, style }: {
  title?: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
  icon?: string;
  pad?: number;
  style?: CSSProperties;
}) {
  const { T } = useDesign();
  const base: CSSProperties = { background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radius,
    boxShadow: T.cardShadow, minWidth: 0, ...style };
  const caixa = pad === undefined
    ? porFaixa(base, { padding: { largo: 24, compacto: 18 } })
    : { style: { ...base, padding: pad } };
  return (
    <div {...caixa}>
      {title && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            {icon && <Icon d={icon} s={17} style={{ color: T.textMuted }} />}
            <h3 style={{ margin: 0, fontFamily: T.font.display, fontSize: 17,
              fontWeight: 600, color: T.text, letterSpacing: '-0.01em' }}>{title}</h3>
          </div>
          {sub && <div style={{ fontSize: 12.5, color: T.textFaint, marginTop: 5, lineHeight: 1.5 }}>{sub}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

export function PlaceholderTab() {
  const { T } = useDesign();
  return (
    <AnalyzerCard>
      <div style={{ padding: '60px 30px', textAlign: 'center' }}>
        <div style={{ fontFamily: T.font.display, fontSize: 20, fontWeight: 600, color: T.text, marginBottom: 8 }}>Análise indisponível</div>
        <div style={{ fontSize: 14, color: T.textMuted, maxWidth: 420, margin: '0 auto', lineHeight: 1.5 }}>
          Esta análise ainda não está disponível para este recorte.</div>
      </div>
    </AnalyzerCard>
  );
}
