"use client";

import { useEffect, useRef } from "react";
import { fmtOdds, fmtPct } from "@/src/domain/formato-de-resultado";
import type { ApostaData } from "../../action-contracts";
import { useDesign } from "../../kit/context";
import { MetricaComDefinicao } from "../../kit/MetricaComDefinicao";
import styles from "./clv-origem.module.css";
import type { CssVarsStyle } from "../../kit/css-vars";

type OrigemDoClv = NonNullable<ApostaData>["d"]["clvOrigem"];

/**
 * "De onde veio esse CLV": a cadeia de contas por trás do número (odd cravada →
 * bruta da Pinnacle → fair devigada → CLV). Com a cadeia aberta, um CLV certo
 * pela fórmula e errado pelo mundo (fechamento retroativo contra uma aposta ao
 * vivo) se denuncia. Sem CLV, o painel diz o motivo e os minutos após o apito.
 */
export function ClvOrigem({
  origem,
  aposApito,
  onFechar,
}: {
  origem: OrigemDoClv | null | undefined;
  aposApito: number | null;
  onFechar: () => void;
}) {
  const { T, ink } = useDesign();
  const ref = useRef<HTMLDivElement>(null);

  // Abriu por teclado ou clique: leva o foco para o painel e devolve com Esc.
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onFechar(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onFechar]);

  const vars: CssVarsStyle = {
    "--co-surface": T.surface,
    "--co-surface-2": T.surface2,
    "--co-border": T.border,
    "--co-border-soft": T.borderSoft,
    "--co-text": T.text,
    "--co-muted": T.textMuted,
    "--co-faint": T.textFaint,
    "--co-accent": T.accent,
    "--co-shadow": T.cardShadow,
    "--co-radius": `${T.radius}px`,
    "--co-radius-md": `${T.radiusMd}px`,
    "--co-radius-sm": `${T.radiusSm}px`,
    "--co-display": T.font.display,
    "--co-body": T.font.body,
    "--co-num": T.font.num,
  };

  const cadeia = origem?.clv != null && origem.fechamentoFair != null
    ? { ...origem, clv: origem.clv, fechamentoFair: origem.fechamentoFair }
    : null;

  const degraus = cadeia ? [
    { rotulo: "Sua odd cravada", sub: "o preço que você pegou", metrica: null, valor: fmtOdds(cadeia.cravada) },
    ...(cadeia.fechamentoBruto != null
      ? [{ rotulo: "Pinnacle no fechamento", sub: "odd bruta, ainda com o juice", metrica: "devig", valor: fmtOdds(cadeia.fechamentoBruto) }]
      : []),
    { rotulo: "Fair devigada", sub: "preço estimado sem a margem da casa", metrica: "fairOdd", valor: fmtOdds(cadeia.fechamentoFair) },
  ] : [];

  return (
    <div ref={ref} tabIndex={-1} className={styles.painel} style={vars} role="region" aria-label="Procedência do CLV">
      <div className={styles.cabeca}>
        <h3 className={styles.titulo}>De onde veio esse CLV</h3>
        <button type="button" className={styles.fechar} onClick={onFechar}>Fechar (Esc)</button>
      </div>
      <div className={styles.sub}>
        CLV compara a sua odd com a linha que <b>fechou</b>, já sem o juice. Não é
        &ldquo;bater a odd bruta&rdquo;: a fair devigada é o preço estimado sem margem,
        e é contra ela que a diferença se mede.
      </div>

      {cadeia ? (
        <>
          <div className={styles.cadeia}>
            {degraus.map((d) => (
              <div key={d.rotulo} className={styles.degrau}>
                <span className={styles.rotulo}>
                  {d.metrica
                    ? <MetricaComDefinicao metrica={d.metrica} bloco={false}>{d.rotulo}</MetricaComDefinicao>
                    : d.rotulo}
                  <small>{d.sub}</small>
                </span>
                <span className={styles.valor}>{d.valor}</span>
              </div>
            ))}
            <div className={`${styles.degrau} ${styles.resultado}`}>
              <span className={styles.rotulo}>CLV</span>
              <span className={styles.valor} style={{ color: ink(cadeia.clv) }}>{fmtPct(cadeia.clv)}</span>
            </div>
          </div>
          <div className={styles.rodape}>
            {cadeia.provider && <span>provider <b>{cadeia.provider}</b></span>}
            {cadeia.mecanismo && <span>origem <b>{cadeia.mecanismo}</b></span>}
            {cadeia.congeladoEm && <span>congelado <b>{cadeia.congeladoEm}</b></span>}
            {cadeia.confiavel === false && <span>marcado como <b>não confiável</b></span>}
          </div>
        </>
      ) : (
        <div className={styles.ausente}>
          <span className={styles.ausenteMarca} />
          <div className={styles.ausenteTexto}>
            {origem?.motivo ?? "Fechamento ainda não congelado."}
            <span>
              {aposApito != null
                ? `Registrada ${aposApito} min depois do apito — comparar com a linha de fechamento mediria o que o jogo fez, não a sua vantagem.`
                : "Enquanto a linha não congela no kickoff, qualquer comparação usaria um preço que ainda se move."}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
