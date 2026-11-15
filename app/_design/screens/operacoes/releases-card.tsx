import { useDesign } from "../../kit/context";
import { contagem } from "../../lib/plural";
import { RELEASE_ERROR_MIN_OCCURRENCES, RELEASE_OBSERVATION_MINUTES } from "@/src/domain/release-verdict";
import { OpsCard, SectionHead } from "./ui-primitives";
import styles from "./operacoes.module.css";
import type { MonitoramentoData } from "../../adapters/operacoes";
import type { CssVarsStyle } from "../../kit/css-vars";
import type { Theme } from "../../theme";

type ReleaseView = MonitoramentoData["releases"][number];
type FindingView = ReleaseView["findings"][number];

const STATE_LABEL: Record<ReleaseView["state"], string> = {
  erro_novo: "Erro novo",
  sem_erro_novo: "Sem erro novo",
  em_observacao: "Em observação",
  sem_veredito: "Sem veredito",
};

function stateTone(T: Theme, state: ReleaseView["state"]): string {
  if (state === "erro_novo") return T.neg;
  if (state === "sem_erro_novo") return T.pos;
  if (state === "em_observacao") return T.accent;
  return T.textFaint;
}

const NOTICE_TEXT: Record<NonNullable<ReleaseView["notice"]>, string> = {
  sent: "Aviso enviado no Telegram.",
  retrying: "Aviso no Telegram ainda não saiu; o job tenta de novo por 24 h depois do veredito.",
  gave_up: "O aviso no Telegram não saiu nas 24 h de tentativas; o veredito fica só aqui.",
};

/**
 * O zero não pode dizer mais do que foi medido: falha de fornecedor e o erro
 * novo abaixo do mínimo não contam como erro da release, mas existiram.
 */
function verdictDetail(release: ReleaseView): string | null {
  if (release.state === "em_observacao") {
    return `Veredito a partir de ${release.verdictFrom}, depois de ${RELEASE_OBSERVATION_MINUTES} min no ar.`;
  }
  if (release.state === "sem_veredito") {
    return "Não foi julgada nas 24 h seguintes: o worker ficou parado ou o job ops.release_verdict falhou.";
  }
  if (release.state === "erro_novo") return release.notice ? NOTICE_TEXT[release.notice] : null;
  const known = release.knownErrors ?? 0;
  const lead = release.belowThreshold.length > 0
    ? `Nenhum erro novo chegou a ${RELEASE_ERROR_MIN_OCCURRENCES} tentativas`
    : `Nenhum erro atribuível à release nos ${RELEASE_OBSERVATION_MINUTES} min de observação`;
  return known > 0
    ? `${lead}; ${contagem(known, "falha")} de ${known === 1 ? "erro já conhecido" : "erros já conhecidos"}.`
    : `${lead}.`;
}

function belowThresholdLead(findings: readonly FindingView[]): string {
  const attempts = findings.reduce((sum, finding) => sum + finding.occurrences, 0);
  const one = findings.length === 1;
  return `${contagem(attempts, "tentativa")} de ${one ? "um erro novo" : `${findings.length} erros novos`}, `
    + `abaixo do mínimo de ${RELEASE_ERROR_MIN_OCCURRENCES}: ${one ? "não virou aviso e passa" : "não viraram aviso e passam"} `
    + `a contar como ${one ? "conhecido" : "conhecidos"}.`;
}

function FindingList({ findings, faint = false }: { findings: readonly FindingView[]; faint?: boolean }) {
  const { numFont } = useDesign();
  return (
    <ul className={faint ? `${styles.releaseFindings} ${styles.releaseFindingsFaint}` : styles.releaseFindings}>
      {findings.map((finding) => (
        <li key={finding.id}>
          <span className={styles.mono} style={numFont}>{finding.queue}</span> — {finding.text}{" "}
          <span className={styles.textFaint}>
            · {finding.occurrences}× em {contagem(finding.jobs, "job")} · desde {finding.firstAt}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Releases com o veredito de cada uma: o erro de fila nunca visto que
 * apareceu junto com ela. Mora em Desempenho, sem botão: desfazer é revert na
 * main, e o aviso já chegou pelo Telegram.
 */
export function ReleasesCard({ releases }: { releases: MonitoramentoData["releases"] }) {
  const { T, numFont } = useDesign();
  const flaggedCount = releases.filter((release) => release.state === "erro_novo").length;
  const hintStyle: CssVarsStyle = { "--ops-hint-color": flaggedCount ? T.neg : T.textFaint };
  return (
    <OpsCard className={styles.cardSpace}>
      <SectionHead
        title="Releases"
        sub={`erro novo nos ${RELEASE_OBSERVATION_MINUTES} min depois de cada publicação`}
        right={releases.length > 0 ? (
          <span className={styles.sectionHint} style={hintStyle}>
            {flaggedCount ? `${flaggedCount} com erro novo` : `últimas ${releases.length}`}
          </span>
        ) : null}
      />
      {releases.length === 0 ? (
        <div className={styles.sloEmpty}>
          Nenhuma release registrada. A primeira aparece quando o worker de uma publicação ficar pronto.
        </div>
      ) : (
        <ul className={styles.releaseList} aria-label="Releases recentes">
          {releases.map((release) => {
            const rowStyle: CssVarsStyle = {
              "--ops-tone": stateTone(T, release.state),
              "--ops-job-status": release.state === "erro_novo" ? T.neg : T.textMuted,
            };
            const detail = verdictDetail(release);
            return (
              <li key={release.id} className={styles.releaseRow} style={rowStyle}>
                <div className={styles.jobHead}>
                  <span className={styles.jobDot} />
                  <span className={styles.jobName}>{release.id}</span>
                  <span className={styles.jobStatus}>
                    <b>{STATE_LABEL[release.state]}</b> <span className={styles.textFaint}>·</span>{" "}
                    <span className={styles.mono} style={numFont}>{release.at}</span>{" "}
                    <span className={styles.textFaint}>({release.ago})</span>
                  </span>
                </div>
                {release.findings.length > 0 ? <FindingList findings={release.findings} /> : null}
                {detail ? <div className={styles.jobNext}>{detail}</div> : null}
                {release.belowThreshold.length > 0 ? (
                  <>
                    <div className={styles.jobNext}>{belowThresholdLead(release.belowThreshold)}</div>
                    <FindingList findings={release.belowThreshold} faint />
                  </>
                ) : null}
                <div className={styles.releaseLinks}>
                  <a href={release.commitUrl} target="_blank" rel="noopener noreferrer" className={styles.releaseLink}>
                    Commit <span className={styles.mono} style={numFont}>{release.sha}</span>
                  </a>
                  {release.compareUrl ? (
                    <a href={release.compareUrl} target="_blank" rel="noopener noreferrer" className={styles.releaseLink}>
                      Mudanças desde a anterior
                    </a>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className={styles.releaseNote}>
        Conta o erro de fila que não aparecia antes e se repetiu ao menos {RELEASE_ERROR_MIN_OCCURRENCES} vezes.
        Fornecedor fora, circuito aberto e o worker saindo no deploy não contam.
        Aparecer junto não prova que a release é a causa: um fornecedor que mudou dá o mesmo sinal.
      </p>
    </OpsCard>
  );
}
