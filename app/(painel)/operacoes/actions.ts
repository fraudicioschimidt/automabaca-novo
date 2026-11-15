"use server";

import { revalidatePath } from "next/cache";
import { revalidateFinancialViews } from "../_revalidate";
import { z } from "zod";
import { getSharedBoss } from "@/src/infra/boss";
import { enqueueSharpEnrich } from "@/src/services/scheduling/enqueue-enrich";
import { reprocessarBetSharp, reprocessarTransitoriosDoCanal } from "@/src/services/ops/reprocess";
import { replayDeadLetters } from "@/src/services/ops/dlq/replay";
import { requestDiscardedPostCapture } from "@/src/services/capture/channel/channel-post-archive";
import {
  approveIaJudgeSuggestion,
  rejectIaJudgeSuggestion,
} from "@/src/services/settlement/ia-judge/suggestions";
import { ignorarTrainingCase, resolverTrainingCase } from "@/src/services/sharp/training-resolve";
import { actor } from "../_auth";
import { refusalAsResult, type ActionResult } from "@/src/services/shared/recusa";
import { observeAction } from "@/app/_lib/observed-action";
import {
  acknowledgeOperationalAction,
  closeOperationalAction,
} from "@/src/services/ops/operational-actions";

import { settleBetsAction as runSettleBetsBatch, type SettleBetRequest } from "./actions-settle-batch";

/** Settlement manual em lote — wrapper "use server" sobre o helper sem diretiva. */
export async function settleBetsAction(
  items: SettleBetRequest[],
  result: "won" | "half_won" | "lost" | "half_lost" | "void" | "pending",
): ReturnType<typeof runSettleBetsBatch> {
  return runSettleBetsBatch(items, result);
}

const UUID_ID = z.string().uuid();

// Id malformado é defeito do cliente, não recusa: segue como erro e conta na
// taxa de erro da action. A recusa com mensagem ao operador vem dos serviços.
function requireUuidId(value: unknown, label: string): string {
  const parsed = UUID_ID.safeParse(value);
  if (!parsed.success) throw new Error(`${label} inválido.`);
  return parsed.data;
}

function requireTelegramChannelId(value: unknown): string {
  if (typeof value !== "string" || !/^-?[1-9]\d{0,19}$/.test(value)) {
    throw new Error("Canal inválido.");
  }
  return value;
}

/**
 * Matching: resolve um caso de treino escolhendo o candidato (por índice). O
 * jogo vale para a aposta, e os nomes do tipster entram confirmados nas fichas
 * dos times; o nome que não pôde ser ensinado volta como aviso.
 */
export async function resolveMatchAction(caseId: string, candidateIndex: number, candidateHash: string): Promise<ActionResult<{ notice?: string }>> {
  const who = await actor();
  return refusalAsResult(async () => {
    const parsedCaseId = requireUuidId(caseId, "Caso");
    if (!Number.isSafeInteger(candidateIndex) || candidateIndex < 0) {
      throw new Error("Candidato inválido.");
    }
    const expectedCandidateHash = z.string().regex(/^[0-9a-f]{64}$/).parse(candidateHash);
    const { nomes } = await observeAction("training.resolve", async () => {
      const resolved = await resolverTrainingCase({ caseId: parsedCaseId, candidateIndex, actor: who, expectedCandidateHash });
      // Mantém a correlação da decisão manual até o job de enrich persistido.
      if (resolved.betId) {
        const boss = await getSharedBoss();
        await enqueueSharpEnrich(boss, resolved.betId);
      }
      return resolved;
    });
    revalidatePath("/operacoes");
    const naoEnsinados = nomes.filter((n) => !["ensinado", "ja_confirmado", "mesmo_nome"].includes(n.resultado));
    return naoEnsinados.length > 0
      ? { notice: naoEnsinados.map((n) => `"${n.nome}": ${n.mensagem}`).join(" · ") }
      : {};
  });
}

/** Matching: adia o caso por 2h sem tornar a identidade terminal. */
export async function ignoreMatchAction(caseId: string): Promise<ActionResult> {
  const who = await actor();
  return refusalAsResult(async () => {
    const parsedCaseId = requireUuidId(caseId, "Caso");
    await observeAction("training.ignore", () => ignorarTrainingCase(parsedCaseId, who));
    revalidatePath("/operacoes");
    return {};
  });
}

/** Pendência sharp: reenfileira o enrich da aposta na Pinnacle. */
export async function retrySharpAction(betId: string): Promise<ActionResult> {
  const who = await actor();
  return refusalAsResult(async () => {
    const parsedBetId = requireUuidId(betId, "Aposta");
    await observeAction("sharp.reprocess", async () =>
      reprocessarBetSharp(parsedBetId, who),
    );
    revalidatePath("/operacoes");
    revalidateFinancialViews();
    return {};
  });
}

/** Monitoramento: reenfileira todos os membros do incidente agrupado. */
export async function replayJobAction(jobIds: string[]): Promise<ActionResult<{
  replayed: number;
  alreadyGone: number;
  failures: number;
}>> {
  const who = await actor();
  return refusalAsResult(async () => {
    const parsedJobIds = z.array(UUID_ID).min(1).max(200).safeParse(jobIds);
    if (!parsedJobIds.success) throw new Error("Jobs inválidos (esperado 1–200 UUIDs).");
    const r = await observeAction(
      "job.replay",
      async () => replayDeadLetters(parsedJobIds.data, who),
      (result) => ({
        outcome: result.failures > 0
          ? "error"
          : result.replayed > 0
            ? "success"
            : "expected_retry",
        labels: {
          replayed: result.replayed,
          alreadyGone: result.alreadyGone,
          failures: result.failures,
        },
      }),
    );
    revalidatePath("/operacoes");
    revalidatePath("/monitoramento");
    return { replayed: r.replayed, alreadyGone: r.alreadyGone, failures: r.failures };
  });
}

/** IA-Judge: homologa sugestão — liquida a tip + marca APPROVED na mesma tx. */
export async function approveIaJudgeAction(suggestionId: string): Promise<ActionResult> {
  const who = await actor();
  return refusalAsResult(async () => {
    const parsedSuggestionId = requireUuidId(suggestionId, "Sugestão");
    await observeAction("ia_judge.approve", () =>
      approveIaJudgeSuggestion({ suggestionId: parsedSuggestionId, actor: who }),
    );
    revalidateFinancialViews();
    return {};
  });
}

/** IA-Judge: rejeita sugestão — tip permanece PENDING. */
export async function rejectIaJudgeAction(suggestionId: string): Promise<ActionResult> {
  const who = await actor();
  return refusalAsResult(async () => {
    const parsedSuggestionId = requireUuidId(suggestionId, "Sugestão");
    await observeAction("ia_judge.reject", () =>
      rejectIaJudgeSuggestion({ suggestionId: parsedSuggestionId, actor: who }),
    );
    revalidatePath("/operacoes");
    return {};
  });
}

export async function retryChannelTransientAction(
  channelId: string,
): Promise<ActionResult<{
  totalElegiveis: number;
  elegiveis: number;
  enfileiradas: number;
  puladas: number;
}>> {
  const who = await actor();
  return refusalAsResult(async () => {
    const parsedChannelId = requireTelegramChannelId(channelId);
    const result = await observeAction("channel.reprocess_transient", async () =>
      reprocessarTransitoriosDoCanal(parsedChannelId, who),
    );
    revalidatePath("/monitoramento");
    return {
      totalElegiveis: result.totalElegiveis,
      elegiveis: result.elegiveis,
      enfileiradas: result.enfileiradas,
      puladas: result.puladas,
    };
  });
}

/** "Capturar mesmo assim": post barrado pelo filtro volta à captura no worker, sem o filtro. */
export async function captureDiscardedPostAction(
  channelId: string,
  messageId: number,
): Promise<ActionResult<{ status: "enfileirado" | "ja_na_fila" | "ja_pedido" }>> {
  const who = await actor();
  return refusalAsResult(async () => {
    const parsedChannelId = requireTelegramChannelId(channelId);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error("Post inválido.");
    const status = await observeAction("channel.capture_discarded", () =>
      requestDiscardedPostCapture({ chatId: parsedChannelId, messageId, actor: who }));
    revalidatePath("/monitoramento");
    return { status };
  });
}

export async function acknowledgeOperationalActionAction(actionId: string): Promise<ActionResult> {
  const who = await actor();
  return refusalAsResult(async () => {
    const parsedActionId = requireUuidId(actionId, "Ação");
    await observeAction("operational_action.acknowledge", () =>
      acknowledgeOperationalAction(parsedActionId, who));
    revalidatePath("/operacoes");
    revalidatePath("/monitoramento");
    return {};
  });
}

/** Encerrar = a condição foi tratada. */
export async function resolveOperationalActionAction(actionId: string): Promise<ActionResult> {
  const who = await actor();
  return refusalAsResult(async () => {
    const parsedActionId = requireUuidId(actionId, "Ação");
    await observeAction("operational_action.resolve", () =>
      closeOperationalAction(
        parsedActionId,
        who,
        "RESOLVED",
        "Resolvida manualmente pelo operador.",
      ));
    revalidatePath("/operacoes");
    revalidatePath("/monitoramento");
    return {};
  });
}
