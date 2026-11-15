import { rotuloStatus } from "@/src/domain/mensagem-operador";
import { toNumber } from "@/src/domain/money";
import { judgeWindowClosesAt } from "@/src/domain/settlement/eligibility";
import { resolveTicketFromScore, type EligibleBet, type FixtureScore } from "@/src/domain/settlement/ticket-resolution";
import type { BetStatus } from "@/src/generated/prisma/enums";
import { OperationalRisk } from "@/src/generated/prisma/enums";
import { sendOperationalAlert } from "@/src/services/ops/alerts";
import { setCooldown } from "@/src/services/settlement/ia-judge/candidates";

/**
 * Conferência, pelo FlashScore, da aposta que o IA-Judge liquidou. Nunca
 * liquida, reembolsa nem mexe na conta: compara o resultado que o placar daria
 * com o gravado e avisa o dono quando diverge ou quando não dá para conferir.
 */

export type CrossCheckVerdict =
  /** O que a liquidação automática decidiria, e com que evidência. */
  | { kind: "status"; status: BetStatus; evidence: string }
  /** Jogo ainda sem desfecho: a observação continua aberta. */
  | { kind: "wait"; outcome: string }
  /** O placar existe, mas não decide esta aposta: o dono precisa saber. */
  | { kind: "uncomparable"; outcome: string; reason: "extra_time" | "interrupted" | "cancelled" }
  /** Mercado que a conferência não cobre (custaria chamadas extras). */
  | { kind: "none"; outcome: string };

export type CrossCheckResult = { settlementOutcome: string; observationFinal?: boolean };

const UNCOMPARABLE_TEXT: Record<"extra_time" | "interrupted" | "cancelled", string> = {
  cancelled: "há perna anulada no bilhete e a regra da casa exige conferência",
  extra_time: "o jogo foi à prorrogação ou aos pênaltis",
  interrupted: "o jogo não foi jogado até o fim (abandono, W.O. ou resultado decidido fora de campo)",
};

export async function reportIaCrossCheck(
  bet: Pick<EligibleBet, "id" | "evento" | "selecao" | "status" | "data">,
  verdict: CrossCheckVerdict,
  now: Date,
): Promise<CrossCheckResult> {
  if (verdict.kind === "wait") return { settlementOutcome: verdict.outcome, observationFinal: false };
  if (verdict.kind === "none") return { settlementOutcome: verdict.outcome };
  if (verdict.kind === "uncomparable") {
    await sendOperationalAlert(
      `🔁 Não consegui conferir a liquidação da IA · ${bet.evento}\n` +
        `${bet.selecao}: está como ${rotuloStatus(bet.status)} (liquidada pela IA), mas ` +
        `${UNCOMPARABLE_TEXT[verdict.reason]}, e o placar do FlashScore não confirma o resultado.\n` +
        "👉 Confira a regra da casa e, se estiver errado, corrija em Operações liquidando com o resultado certo.",
      {
        source: "settlement.ia-judge-crosscheck",
        key: bet.id,
        title: `Liquidação da IA sem conferência: ${bet.evento}`,
        risk: OperationalRisk.MEDIUM,
        resource: "bet",
        resourceId: bet.id,
        evidence: { statusAtual: bet.status, motivo: verdict.reason },
        autoResolve: false,
      },
    );
    return { settlementOutcome: verdict.outcome };
  }
  if (verdict.status === bet.status) return { settlementOutcome: "crosscheck_agrees" };
  // Antes do alerta: se ele falhar, a próxima passada repete, e a IA já não
  // volta a esta aposta. Até o dono (ou o FlashScore, se a aposta for reaberta)
  // decidir, sugerir de novo só repetiria o erro.
  await setCooldown(
    `bet:${bet.id}`,
    Math.max(judgeWindowClosesAt(bet.data).getTime() - now.getTime(), 24 * 3_600_000),
    "flashscore_crosscheck_divergence",
    now,
  );
  await sendOperationalAlert(
    `🔁 IA e FlashScore divergem · ${bet.evento}\n` +
      `${bet.selecao}: está como ${rotuloStatus(bet.status)} (liquidada pela IA), ` +
      `mas pelo FlashScore (${verdict.evidence}) seria ${rotuloStatus(verdict.status)}.\n` +
      "A IA não volta a sugerir nem liquidar esta aposta.\n" +
      "👉 Confira na casa e, se estiver errado, corrija em Operações liquidando com o resultado certo.",
    {
      source: "settlement.ia-judge-crosscheck",
      key: bet.id,
      title: `Liquidação da IA divergente: ${bet.evento}`,
      risk: OperationalRisk.HIGH,
      resource: "bet",
      resourceId: bet.id,
      evidence: { statusAtual: bet.status, peloFlashscore: verdict.status, evidencia: verdict.evidence },
      autoResolve: false,
    },
  );
  return { settlementOutcome: "crosscheck_diverges" };
}

/**
 * O que a liquidação de uma múltipla decidiria com as olhadas deste ciclo, sem
 * aplicar nada. Espelha `settleTicket`: todas canceladas é VOID; confronto na
 * prorrogação ou interrompido não se decide pelo placar.
 */
export function ticketCrossCheckVerdict(
  bet: EligibleBet,
  params: {
    final: boolean;
    allCancelled: boolean;
    partiallyCancelled: boolean;
    scoresByEvento: readonly FixtureScore[];
    extraTimeBlocked: readonly string[];
    interrupted: readonly string[];
  },
): CrossCheckVerdict {
  if (!params.final) return { kind: "wait", outcome: "not_attempted" };
  if (params.interrupted.length > 0) {
    return { kind: "uncomparable", outcome: "crosscheck_interrupted", reason: "interrupted" };
  }
  if (params.extraTimeBlocked.length > 0) {
    return { kind: "uncomparable", outcome: "crosscheck_extra_time", reason: "extra_time" };
  }
  if (params.allCancelled) {
    return { kind: "status", status: "VOID", evidence: "todos os jogos cancelados ou adiados" };
  }
  if (params.partiallyCancelled) {
    return { kind: "uncomparable", outcome: "crosscheck_cancelled", reason: "cancelled" };
  }
  const first = params.scoresByEvento[0];
  if (!first) return { kind: "none", outcome: "crosscheck_not_comparable" };
  const resolution = resolveTicketFromScore(bet, {
    homeScore: first.home,
    awayScore: first.away,
    odds: toNumber(bet.odds),
    stake: toNumber(bet.stake),
    scoresByEvento: params.scoresByEvento,
  });
  return resolution.ok
    ? {
        kind: "status",
        status: resolution.status,
        evidence: params.scoresByEvento.map((score) => `${score.evento} ${score.home}-${score.away}`).join("; "),
      }
    : { kind: "none", outcome: "crosscheck_not_comparable" };
}
