import { concentracao, fraseDeConcentracao } from "../../lib/concentracao";
import { useDesign } from "../../kit/context";
import { contagem } from "../../lib/plural";
import styles from "./tira-de-concentracao.module.css";
import { cssVars } from "../../kit/css-vars";
import { useMoneyFormat } from "./ui-primitives";

/**
 * Quanto do stake está nos maiores grupos — risco de carteira em uma linha.
 *
 * Some sozinha quando não há o que afirmar (recorte vazio, stake zero): ocupar
 * espaço para dizer "não sei" é pior que não aparecer.
 */
export function TiraDeConcentracao({ linhas, substantivo, n = 5 }: {
  linhas: Parameters<typeof concentracao>[0];
  /** No plural ("ligas", "casas", "mercados"). */
  substantivo: string;
  n?: number;
}) {
  const { T } = useDesign();
  const money = useMoneyFormat();
  const c = concentracao(linhas, n);
  const frase = fraseDeConcentracao(c, substantivo);
  if (!frase) return null;
  return (
    <div
      className={styles.tira}
      style={cssVars({
        '--tc-font': T.font.body,
        '--tc-cor': T.textMuted,
        '--tc-forte': T.text,
        '--tc-borda': T.borderSoft,
        '--tc-fundo': T.surface2,
        '--tc-ponto': T.accent,
      })}
    >
      <span className={styles.ponto} />
      {/* Frase inteira num span: solta, o <b> vira item flex e o `gap` do
          container abre buraco no meio dela. */}
      {/* O detalhe só entra quando HÁ corte: com menos grupos que o top-N, o
          topo é o total e "30.25u de 30.25u · 37 apostas de 37" não informa nada. */}
      <span>
        <b>{frase}</b>
        {c.parcial ? null : <>{' '}{money.amount(c.stakeTop)} de {money.amount(c.stakeTotal)} · {contagem(c.apostasTop, 'aposta')} de {c.apostasTotal}.</>}
      </span>
    </div>
  );
}
