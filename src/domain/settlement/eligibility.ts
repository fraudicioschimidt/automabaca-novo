/**
 * Janela de elegibilidade do IA-Judge (mercados que placar nenhum resolve).
 *
 * Antes de 6h o placar/estatística final pode não estar publicado; depois de
 * 30 dias ainda permite recuperação tardia; depois disso a tip parada é caso
 * para revisão humana, não para gastar busca.
 */
const JUDGE_MIN_HOURS_AFTER_KICKOFF = 6;
const JUDGE_MAX_DAYS_AFTER_KICKOFF = 30;

export type JudgeKickoffWindow = {
  /** Kickoff mais recente aceito (evento terminou há >= 6h). */
  maxKickoff: Date;
  /** Kickoff mais antigo aceito (evento há <= 30 dias). */
  minKickoff: Date;
};

export function judgeKickoffWindow(ref: Date): JudgeKickoffWindow {
  return {
    maxKickoff: new Date(ref.getTime() - JUDGE_MIN_HOURS_AFTER_KICKOFF * 3_600_000),
    minKickoff: new Date(ref.getTime() - JUDGE_MAX_DAYS_AFTER_KICKOFF * 24 * 3_600_000),
  };
}

/** Depois deste instante a aposta sai da janela do IA-Judge de vez. */
export function judgeWindowClosesAt(kickoff: Date): Date {
  return new Date(kickoff.getTime() + JUDGE_MAX_DAYS_AFTER_KICKOFF * 24 * 3_600_000);
}
