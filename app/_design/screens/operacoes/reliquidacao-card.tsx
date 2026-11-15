import Link from "next/link";
import { useDesign } from "../../kit/context";
import { rotuloDeStatus } from "@/src/domain/status-de-aposta";
import { plural } from "../../lib/plural";
import { OpsCard, SectionHead } from "./ui-primitives";
import styles from "./operacoes.module.css";
import type { MonitoramentoData } from "../../adapters/operacoes";

/**
 * Resultado trocado DEPOIS de a aposta já estar liquidada (edição do post,
 * caixa de ações, recálculo), que de outro modo só aparece abrindo aposta por
 * aposta.
 *
 * Mora em Manutenção, sem botão: é informação para CONFERIR. O que exige
 * decisão vive em Incidentes, apoiado em `OperationalAction`.
 */
export function ReliquidacaoCard({ reliquidacao }: { reliquidacao?: MonitoramentoData["reliquidacao"] | null }) {
  const { numFont } = useDesign();
  const r = reliquidacao ?? { apostas: 0, eventos: 0, recentes: [] };
  return (
    <OpsCard className={styles.columnCard}>
      <SectionHead title="Resultado alterado" sub="depois de liquidada · 30 dias" />
      {r.apostas === 0 ? (
        <div className={styles.noOddsFoot}>
          Nenhum resultado foi reescrito depois da liquidação nos últimos 30 dias.
        </div>
      ) : (
        <>
          <div className={styles.noOddsIntro}>
            <b style={numFont}>{r.apostas}</b> {plural(r.apostas, "aposta")} em{" "}
            <b style={numFont}>{r.eventos}</b> {plural(r.eventos, "troca")} — confira se o
            ledger bate
          </div>
          {r.recentes.map((x) => (
            <Link key={`${x.betId}-${x.em}`} href={`/aposta?id=${x.betId}`} prefetch={false} className={styles.noOddsRow}>
              <div className={styles.noOddsBody}>
                <div className={styles.noOddsReason}>{x.evento}</div>
                {/* Mesmo vocabulário da ficha: exibir `VOID → LOST` aqui e
                    "reembolso → perdida" lá é o mesmo fato em dois idiomas. A
                    fonte já chega em prosa do servidor — ver `reliquidacao.ts`. */}
                <div className={styles.noOddsSegment}>
                  <span className={styles.noOddsLado}>{rotuloDeStatus(x.de)} → {rotuloDeStatus(x.para)}</span>
                  {" · "}{x.fonte}
                </div>
              </div>
            </Link>
          ))}
          {r.eventos > r.recentes.length && (
            <div className={styles.noOddsFoot}>
              Mostrando as {r.recentes.length} mais recentes de {r.eventos}.
            </div>
          )}
        </>
      )}
    </OpsCard>
  );
}
