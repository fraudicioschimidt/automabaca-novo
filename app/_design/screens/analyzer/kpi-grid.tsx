import { DeltaVsAnterior } from "./shared";
import styles from "./kpi-grid.module.css";
import { Icon } from "../../kit/icons";
import { useDesign } from "../../kit/context";
import { Cap } from "../../kit/primitives";
import { cssVars } from "../../kit/css-vars";
import { AnalyzerCard } from "./ui-primitives";
import type { EmCurso } from "../../lib/balde-em-curso";

export type KpiItem = {
  /** Rótulo e chave. */
  k: string;
  icon?: string;
  /** Valor já formatado. */
  v: string;
  /** Cor do valor. */
  c: string;
  /** Linha de apoio. */
  sub: string;
  atual?: number | null;
  antes?: number | null;
  baseAtual?: number;
  baseAnterior?: number;
  formato?: 'pp' | 'money';
  semRegua?: boolean;
};

/**
 * A faixa de KPIs no topo das abas do Analyzer.
 *
 * `baseAtual`/`baseAnterior` são obrigatórios em todo item que compara, e são a
 * base DA MÉTRICA, não a da janela: lucro e ROI contam resolvidas, CLV conta
 * fechamentos confiáveis e steam conta aberturas.
 *
 * `anterior` é a janela de comparação; sem ela nenhum cartão ganha régua.
 * `semRegua` no item recusa a régua cartão a cartão — é o que separa "não há
 * com o que comparar" de "comparar aqui não significa nada" (as contagens de
 * cobertura do Steam). `emCursoAtual` é o que na janela ATUAL ainda não
 * liquidou: a régua só é veredito quando as duas janelas fecharam.
 */
export function KpiGrid({ itens, numero, legenda = 11.5, anterior = null, emCursoAtual = null }: {
  itens: readonly KpiItem[];
  /** px do valor. */
  numero: number;
  /** px da linha de apoio. */
  legenda?: number;
  anterior?: { rotulo: string } | null;
  emCursoAtual?: EmCurso | null;
}) {
  const { T } = useDesign();
  return (
    <div
      className={styles.grade}
      style={cssVars({
        '--kpi-colunas': itens.length,
        '--kpi-fonte-numero': T.font.num,
        '--kpi-tamanho-numero': `${numero}px`,
        '--kpi-tamanho-legenda': `${legenda}px`,
        '--kpi-apagado': T.textFaint,
      })}
    >
      {itens.map((m) => (
        // O cartão é contêiner: o número encolhe até caber na largura dele
        // ("+R$ 12.345,67" da carteira não vaza a coluna de 390px).
        <AnalyzerCard key={m.k} pad={20} style={{ containerType: 'inline-size' }}>
          {m.icon
            ? <div className={styles.rotulo}><Icon d={m.icon} s={15} /><Cap>{m.k}</Cap></div>
            : <Cap style={{ marginBottom: 12 }}>{m.k}</Cap>}
          {/* O número pode encolher a 18px: mantém a cor semântica AA, inclusive no mobile. */}
          <div className={styles.numero} style={cssVars({ '--kpi-cor-numero': m.c, '--kpi-caracteres': m.v.length })}>{m.v}</div>
          <div className={styles.legenda}>{m.sub}</div>
          {anterior && !m.semRegua && (
            <DeltaVsAnterior atual={m.atual} anterior={m.antes} formato={m.formato}
              base={{ atual: m.baseAtual ?? 0, anterior: m.baseAnterior ?? 0 }}
              rotuloAnterior={anterior.rotulo} emCursoAtual={emCursoAtual} />
          )}
        </AnalyzerCard>
      ))}
    </div>
  );
}
