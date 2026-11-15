import { perdasPorMotivo, type BaseDeCobertura } from "@/src/domain/analyzer/cobertura";
import type { BetRowData } from "@/src/domain/bet-read-model";
import { missingClvReason } from "@/src/domain/no-odds-reason";
import { useDesign } from "../../kit/context";
import { cssVars } from "../../kit/css-vars";
import { AnalyzerCard, useMoneyFormat } from "./ui-primitives";
import type { PropsDaAba } from "./use-analise-do-recorte";
import { contagem, plural } from "../../lib/plural";
import { textoDoQueFicouFora } from "../../lib/cobertura-na-tela";
import { recorteDePerdaDeCobertura } from "../../lib/recorte-de-apostas";
import styles from "./onde-o-clv-se-perde.module.css";

/**
 * Onde a cobertura de CLV se perde, quebrada por motivo: o KPI diz quanto falta,
 * isto diz o que comprar.
 *
 * Some quando não há lacuna (mesma regra da `TiraDeConcentracao`): um cartão
 * de "está tudo bem" treina o olho a ignorar o lugar.
 *
 * Cada linha abre a gaveta com o array que ela mesma contou (`membros`), nunca
 * um filtro refeito aqui, para a linha e a gaveta não divergirem.
 */
export function OndeOClvSePerde({ cobertura, abrirRecorte }: {
  cobertura: BaseDeCobertura<BetRowData>;
  abrirRecorte: PropsDaAba["abrirRecorte"];
}) {
  const { T } = useDesign();
  const money = useMoneyFormat();
  // O mesmo motivo que classificou a aposta em `situacaoDoClv`.
  const perdas = perdasPorMotivo(cobertura.faltando, missingClvReason);
  if (!perdas.length) return null;

  const totalApostas = cobertura.faltando.length;
  const fora = textoDoQueFicouFora(cobertura);

  return (
    <AnalyzerCard
     
      title="Onde o CLV se perde"
      sub={`${contagem(totalApostas, "aposta")} na base alcançável ${plural(totalApostas, "ficou", "ficaram")} sem CLV. Clique para ver quais.`}
      style={{ marginBottom: 22 }}
    >
      <div
        style={cssVars({
          '--pc-font': T.font.body,
          '--pc-text': T.text,
          '--pc-muted': T.textMuted,
          '--pc-faint': T.textFaint,
          '--pc-borda': T.borderSoft,
          '--pc-hover': T.surface2,
          '--pc-accent': T.accent,
          '--pc-fast': T.motion.fast,
        })}
      >
        {perdas.map((p) => (
          <button
            key={p.motivo ?? "sem-motivo"}
            type="button"
            className={styles.linha}
            onClick={() => abrirRecorte(recorteDePerdaDeCobertura(p, { money }))}
            aria-label={`Ver as ${contagem(p.n, "aposta")} sem CLV por ${p.rotulo}`}
          >
            <span className={styles.motivo}>
              <span className={styles.rotulo}>{p.rotulo}</span>
              {p.mercadoDominante ? (
                <span className={styles.mercado}>
                  {p.mercadoDominante}
                  {p.nDoMercado < p.n ? ` e mais ${p.n - p.nDoMercado}` : ''}
                </span>
              ) : null}
            </span>
            <span className={styles.stake}>{money.amount(p.stake)}</span>
            <span className={styles.n}>{contagem(p.n, "aposta")}</span>
          </button>
        ))}
        {fora ? <div className={styles.rodape}>{fora} — o CLV não as alcança.</div> : null}
      </div>
    </AnalyzerCard>
  );
}
