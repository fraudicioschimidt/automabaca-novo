import { OpsCard, SectionHead } from "./ui-primitives";
import styles from "./operacoes.module.css";
import { textoDaBase, textoDoSegmento, type GrupoNaTela, type LacunaNaTela } from "../../lib/lacuna-na-tela";
import { contagem } from "../../lib/plural";
import { ICONS, Icon } from "../../kit/icons";

/** Uma base (fornecedor, sistema ou não se aplica) com as suas linhas por motivo. */
function Grupo({ grupo }: { grupo: GrupoNaTela }) {
  if (grupo.linhas.length === 0) return null;
  return (
    <>
      <div className={styles.noOddsBase}>{textoDaBase(grupo)}</div>
      {grupo.linhas.map((r) => (
        <div key={r.id} className={styles.noOddsRow}>
          <span className={styles.noOddsIcon}><Icon d={ICONS.warn} s={15} /></span>
          <div className={styles.noOddsBody}>
            <div className={styles.noOddsReason}>{r.rotulo}</div>
            <div className={styles.noOddsSegment}>
              <span className={styles.noOddsLado}>{r.lado}</span> · {textoDoSegmento(r)}
            </div>
          </div>
          <span className={styles.noOddsCount}>
            {r.n}
            <span className={styles.noOddsPct}>{r.pct.toFixed(0)}%</span>
          </span>
        </div>
      ))}
    </>
  );
}

/**
 * Sem odds, por motivo — e separado pelo que a ausência significa.
 *
 * O `lado` fica visível na linha porque o mesmo motivo pede conserto diferente
 * em cada ponta: `unsupported_market` na identidade é provider de preço; no
 * fechamento é provider de closing. As três bases vão separadas, na ordem em
 * que pedem decisão: a do fornecedor (comprar cobertura), a do sistema
 * (consertar o motor) e a que não se aplica (entrada ao vivo, política da banca).
 */
export function NoOddsCard({ noOdds }: { noOdds: LacunaNaTela }) {
  return (
    <OpsCard className={styles.columnCard}>
      <SectionHead title="Sem odds" sub="jogos dos últimos 30 dias, por motivo, na identidade, na abertura e no fechamento" />
      <div className={styles.noOddsIntro}>
        {noOdds.total === 0
          ? "Nenhuma aposta sem odds nos últimos 30 dias."
          : `${contagem(noOdds.total, "aposta")} sem odds — a fração é de cada base, não do total.`}
      </div>
      <Grupo grupo={noOdds.fornecedor} />
      <Grupo grupo={noOdds.sistema} />
      <Grupo grupo={noOdds.naoSeAplica} />
      <div className={styles.noOddsFoot}>
        Decisão de cobertura: a fonte sharp não tem a linha. Conserto nosso: o preço existia e o
        motor não o pegou, ou a aposta não diz a linha. O que fica sem CLV aparece por mercado no
        Analyzer do tipster.</div>
    </OpsCard>
  );
}
