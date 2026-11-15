import { emojiStatus, rotuloStatus } from "@/src/domain/mensagem-operador";
import { isRegulationTimeMarket } from "@/src/domain/mercados/compatibility";
import { isScoreResolvableMarket } from "@/src/domain/settlement/markets";
import { resolveResultFromScore } from "@/src/domain/settlement/score-resolution";
import {
  citationSupportingResult,
  isGoogleGroundingRedirectUrl,
  sameTrustedSource,
  verifySportsGrounding,
  type SupportRefusal,
  type VerifiedSportsGrounding,
} from "@/src/domain/trusted-sports-source-url";
import { BetStatus } from "@/src/generated/prisma/client";
import { llmGenerateJson } from "@/src/infra/llm/cascade";
import {
  geminiGenerateJsonWithSearch,
  resolveGroundingRedirectHost,
  type SearchSource,
  type SearchSupport,
} from "@/src/infra/llm/gemini-search";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { sendOperationalAlert, sendOperatorNotification } from "@/src/services/ops/alerts";
import {
  reconcileOperationalActionSource,
  resolveOperationalActionBySourceKey,
} from "@/src/services/ops/operational-actions";
import { POSTPONED_VOID_GRACE_MS } from "../flashscore/settle";
import {
  BATCH_SIZE,
  FAILURE_COOLDOWN_MS,
  findIaJudgeCandidates,
  findStalledSettlementCandidates,
  formatCooldownHours,
  isCooldownActive,
  isQuotaReason,
  loadCurrentCandidate,
  QUOTA_COOLDOWN_MS,
  QUOTA_KEY,
  QUOTA_NOTICE_KEY,
  retryCooldownMs,
  setCooldown,
  type IaJudgeCandidate as Candidate,
} from "./candidates";
import {
  extractFlashscoreJudgeEvidence,
  flashscoreAutoSettleBlocker,
  flashscoreBetSides,
  flashscoreJudgeFacts,
  flashscoreMatchNotPlayed,
  loadFlashscoreSnapshot,
  tryResolveFromFlashscoreStats,
  type FlashscoreJudgeEvidence,
} from "./flashscore-evidence";
import {
  buildSearchPrompt,
  buildStructuredPrompt,
  capDoubtfulConfidence,
  GEMINI_RESPONSE_SCHEMA,
  MIN_CONFIDENCE,
  responseSchema,
  SYSTEM_INSTRUCTION_SEARCH,
  SYSTEM_INSTRUCTION_STRUCTURED,
} from "./prompt";
import {
  approveIaJudgeSuggestion,
  dismissOrphanedIaJudgeSuggestions,
  ownerRejectedIaJudge,
  persistSuggestion,
} from "./suggestions";

/**
 * O ciclo do IA-Judge: para cada candidata, tenta primeiro o que o snapshot
 * FlashScore já responde; senão pergunta ao LLM (evidência estruturada, ou
 * busca na web com citação) e cria a sugestão. Com `autoSettle`, a sugestão
 * do resultado do jogo inteiro com confiança alta e fonte confiável citada
 * liquida sozinha.
 */

const log = createLogger("ia-judge");

export const AUTO_SETTLE_MIN_CONFIDENCE = 0.95;

/**
 * `failed_transient` separa "o provider estava fora" de "o dado está errado":
 * uma indisponibilidade de LLM se resolve sozinha no cooldown e não deve
 * deixar ação aberta para o operador.
 */
type IaJudgeItemResult = "created" | "skipped" | "failed" | "failed_transient";

async function evaluateOne(
  bet: Candidate,
  now: Date,
  options?: { autoSettle?: boolean },
): Promise<IaJudgeItemResult> {
  try {
    // Identidade/kickoff podem mudar pelo enrich enquanto o lote avança: o
    // prompt sempre nasce de um reload.
    const current = await loadCurrentCandidate(bet.id, now);
    if (!current) return "skipped";
    const snapshot = await loadFlashscoreSnapshot(current.id);
    const fromSnapshot = await suggestFromSnapshot(current, snapshot, now);
    if (fromSnapshot) return fromSnapshot;
    return await judgeWithLlm(current, snapshot, now, options);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, betId: bet.id }, "IA-Judge falhou nesta tip");
    await setCooldown(`bet:${bet.id}`, FAILURE_COOLDOWN_MS, msg);
    if (isQuotaReason(msg)) {
      await setCooldown(QUOTA_KEY, QUOTA_COOLDOWN_MS, msg);
      // Cota estourada é espera, não decisão — mesma lógica do LLM indisponível.
      return "failed_transient";
    }
    return "failed";
  }
}

/**
 * Estatística que o snapshot resolve e partida não disputada são fatos do
 * provider, não julgamento: viram sugestão determinística ANTES do LLM. A
 * homologação segue humana.
 */
async function suggestFromSnapshot(
  current: Candidate,
  snapshot: unknown,
  now: Date,
): Promise<"created" | "skipped" | null> {
  const fromStats = tryResolveFromFlashscoreStats({
    mercado: current.mercado,
    selecao: current.selecao,
    evento: current.evento,
    odds: current.odds,
    stake: current.stake,
    resultSnapshot: snapshot,
  });
  if (fromStats?.ok) {
    const home = fromStats.values.home;
    const away = fromStats.values.away;
    const sides = flashscoreBetSides(snapshot);
    const res = await persistSuggestion(current, {
      suggestedStatus: fromStats.status,
      valueFound: `${fromStats.statistic} ${home}-${away}`,
      confidence: 1,
      reason:
        `Resolvido deterministicamente pelo snapshot FlashScore ` +
        `(${fromStats.statistic}: ${sides.first}=${home}, ${sides.second}=${away}).`,
      sourceUrl: null,
      provider: "flashscore-stats",
      evidenceKind: "FLASHSCORE_STRUCTURED",
    });
    return res.outcome;
  }

  const notPlayed = flashscoreMatchNotPlayed(snapshot);
  // ADIADO respeita a mesma graça de 48h do liquidador primário: os dois leem o
  // MESMO snapshot, e a flag do provider volta atrás quando o jogo é remarcado.
  // Cancelado não espera.
  const adiadoEmGraca =
    notPlayed === "postponed" &&
    now.getTime() - current.data.getTime() < POSTPONED_VOID_GRACE_MS;
  if (notPlayed && !adiadoEmGraca) {
    const res = await persistSuggestion(current, {
      suggestedStatus: BetStatus.VOID,
      valueFound: notPlayed,
      confidence: 1,
      reason:
        `Snapshot FlashScore marca a partida como ${
          notPlayed === "cancelled" ? "CANCELADA" : "ADIADA"
        }: sem jogo, a aposta é anulada.`,
      sourceUrl: null,
      provider: "flashscore-status",
      evidenceKind: "FLASHSCORE_STRUCTURED",
    });
    return res.outcome;
  }
  return null;
}

/**
 * Com evidência estruturada o modelo julga sem busca; sem ela, busca com
 * citação. Os fatos do FlashScore (prorrogação, jogo interrompido, jogo ainda
 * sem fim) entram nos dois caminhos: na busca, depois da pergunta.
 */
async function askJudge(
  current: Candidate,
  fsEvidence: FlashscoreJudgeEvidence | null,
  facts: readonly string[],
): Promise<{
  result: { data: unknown; provider: string } | null;
  groundingQuery?: string;
  groundingSources: SearchSource[];
  groundingSupports: SearchSupport[];
}> {
  if (fsEvidence) {
    const result = await llmGenerateJson({
      parts: [{ text: buildStructuredPrompt(current, fsEvidence.evidenceText) }],
      systemInstruction: SYSTEM_INSTRUCTION_STRUCTURED,
      responseSchema: GEMINI_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      label: "ia-judge-structured",
      // Groq e Mistral não impõem o schema: a resposta fora dele passa a vez ao
      // próximo modelo, em vez de encerrar a cascata e esfriar a aposta 24h.
      accept: (data) => responseSchema.safeParse(data).success,
    });
    return { result, groundingSources: [], groundingSupports: [] };
  }
  const groundingQuery = [buildSearchPrompt(current), ...facts].join("\n\n");
  const groundedResult = await geminiGenerateJsonWithSearch({
    query: groundingQuery,
    systemInstruction: SYSTEM_INSTRUCTION_SEARCH,
    responseSchema: GEMINI_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
    label: "ia-judge",
  });
  return {
    result: groundedResult,
    groundingQuery,
    groundingSources: groundedResult?.sources ?? [],
    groundingSupports: groundedResult?.supports ?? [],
  };
}

async function judgeWithLlm(
  current: Candidate,
  snapshot: unknown,
  now: Date,
  options?: { autoSettle?: boolean },
): Promise<IaJudgeItemResult> {
  const fsEvidence = extractFlashscoreJudgeEvidence(snapshot);
  const { result, groundingQuery, groundingSources, groundingSupports } = await askJudge(
    current,
    fsEvidence,
    flashscoreJudgeFacts(snapshot),
  );
  if (!result) {
    // LLM fora do ar não é defeito da tip: FAILURE_COOLDOWN_MS já é a resposta.
    await setCooldown(`bet:${current.id}`, FAILURE_COOLDOWN_MS, "llm_unavailable");
    return "failed_transient";
  }

  const parsed = responseSchema.safeParse(result.data);
  if (!parsed.success) {
    await setCooldown(`bet:${current.id}`, FAILURE_COOLDOWN_MS, "schema_invalid");
    return "failed";
  }

  const v = capDoubtfulConfidence(parsed.data, current, { decidedAfterRegulation: fsEvidence?.decidedAfterRegulation });
  if (!v.resolved) {
    log.info(
      { betId: current.id, confidence: v.confidence, resolved: false },
      "IA-Judge não resolveu — sem sugestão, volta depois do cooldown",
    );
    await setCooldown(`bet:${current.id}`, retryCooldownMs("unresolved", current.data, now), "unresolved", now);
    return "skipped";
  }
  if (v.confidence < MIN_CONFIDENCE) {
    log.info(
      { betId: current.id, confidence: v.confidence, resolved: true },
      "IA-Judge sem confiança suficiente — sem sugestão",
    );
    await setCooldown(`bet:${current.id}`, retryCooldownMs("low_confidence", current.data, now), "low_confidence", now);
    return "skipped";
  }

  // A URL afirmada vem CRUA: o schema do prompt só aceita host confiável e
  // apagaria o redirecionamento do Google, que é o formato real das citações.
  const grounding = verifySportsGrounding(rawClaimedSourceUrl(result.data), groundingSources);
  const groundedSourceUrl = fsEvidence ? null : grounding.sourceUrl;
  const persisted = await persistSuggestion(current, {
    suggestedStatus: BetStatus[v.suggestedOutcome],
    valueFound: v.valueFound,
    confidence: v.confidence,
    reason: v.reason,
    sourceUrl: groundedSourceUrl,
    provider: result.provider,
    evidenceKind: fsEvidence ? "FLASHSCORE_STRUCTURED" : "GROUNDED_WEB",
    groundingQuery,
    groundingSources: fsEvidence ? undefined : grounding.citations,
    groundedAt: fsEvidence ? undefined : new Date(),
  });
  if (persisted.outcome !== "created" || !persisted.suggestionId) {
    return persisted.outcome;
  }

  // Confiança é necessária, mas só grounding citado e aceito autoriza a
  // mutação financeira. Evidência estruturada sem busca e busca sem citação
  // confiável ficam para homologação humana.
  if (options?.autoSettle && v.confidence >= AUTO_SETTLE_MIN_CONFIDENCE) {
    const blocker = flashscoreAutoSettleBlocker(snapshot);
    if (!settlesByFinalScore(current)) {
      log.info(
        { betId: current.id, confidence: v.confidence, mercado: current.mercado },
        "parte do jogo, estatística, múltipla ou entrada ao vivo: homologação do dono",
      );
    } else if (blocker) {
      log.warn(
        { betId: current.id, confidence: v.confidence, blocker },
        "FlashScore viu prorrogação, jogo interrompido ou jogo ainda sem fim — sugestão mantida para homologação",
      );
    } else if (await ownerRejectedIaJudge(current.id)) {
      // O dono já recusou um veredito desta aposta: a IA volta a olhar, mas
      // quem liquida é ele. Antes do HEAD, que não precisa ser gasto.
      log.warn(
        { betId: current.id, confidence: v.confidence },
        "dono já rejeitou sugestão desta aposta — sugestão mantida para homologação",
      );
    } else if (groundedSourceUrl !== null) {
      const refusal = await autoSettleRefusal(grounding, v.valueFound, groundingSupports, current, v.suggestedOutcome);
      if (refusal) {
        log.warn(
          { betId: current.id, confidence: v.confidence, refusal, domain: grounding.sourceDomain },
          "fonte do IA-Judge não confirmada — sugestão mantida para homologação",
        );
      } else {
        await autoSettleGroundedIaJudgeSuggestion({
          suggestionId: persisted.suggestionId,
          current,
          confidence: v.confidence,
          valueFound: v.valueFound,
          reason: v.reason,
          sourceUrl: groundedSourceUrl,
          sourceDomain: grounding.sourceDomain,
          now,
        });
      }
    } else {
      log.warn(
        {
          betId: current.id,
          confidence: v.confidence,
          citations: grounding.citations.length,
          structuredEvidence: Boolean(fsEvidence),
        },
        "IA-Judge sem grounding confiável — sugestão mantida para homologação",
      );
    }
  }
  return "created";
}

/**
 * O IA-Judge só liquida sozinho o que o placar final do jogo inteiro responde
 * (vencedor, total, handicap, ambas marcam, com a prorrogação quando o mercado
 * a declara): é o que a citação consegue provar sem ambiguidade. Parte do
 * jogo, estatística, prop, artilheiro e múltipla viram sugestão para o dono,
 * qualquer que seja a confiança. A aposta pega ao vivo também: no handicap a
 * casa paga só o que veio depois da entrada, e o placar citado é o do jogo
 * inteiro.
 */
function settlesByFinalScore(bet: Candidate): boolean {
  return !bet.combinedTicket && !bet.liveEntry && isScoreResolvableMarket({
    mercado: bet.mercado, selecao: bet.selecao, esporte: bet.esporte, evento: bet.evento,
  });
}

/**
 * O que ainda impede a liquidação sozinha depois de a fonte afirmada estar
 * entre as citações:
 * - um trecho que uma citação do mesmo domínio confiável sustenta
 *   (`groundingSupports`) precisa trazer o placar final deste confronto, na
 *   ordem, sem outro placar nem parte do jogo (`citationSupportingResult`);
 * - a conta do motor com esse placar precisa dar o resultado do modelo
 *   (`statusFromCitedScore`);
 * - o redirecionamento do Google dessa citação (a que sustenta o trecho, não
 *   só a afirmada) precisa apontar para esse domínio: o HEAD confere, e só
 *   aqui, na hora de liquidar, para não gastar requisição com sugestão.
 */
async function autoSettleRefusal(
  grounding: VerifiedSportsGrounding,
  valueFound: string,
  supports: readonly SearchSupport[],
  bet: Candidate,
  suggestedOutcome: string,
): Promise<SupportRefusal | "outcome_not_confirmed" | "redirect_not_confirmed" | null> {
  const domain = grounding.sourceDomain;
  if (!domain) return "result_not_supported";
  const supported = citationSupportingResult({ valueFound, supports, domain, evento: bet.evento });
  if ("refusal" in supported) return supported.refusal;
  if (statusFromCitedScore(bet, supported) !== suggestedOutcome) return "outcome_not_confirmed";
  if (isGoogleGroundingRedirectUrl(supported.citation.url)) {
    const host = await resolveGroundingRedirectHost(supported.citation.url);
    if (!host || !sameTrustedSource(host, domain)) return "redirect_not_confirmed";
  }
  return null;
}

/**
 * O resultado que o motor de placar dá para o placar citado: o veredito do
 * modelo só liquida sozinho quando é o mesmo. Se o trecho não diz de que time
 * é cada número, as duas ordens precisam dar o mesmo resultado (total, ambas
 * marcam, empate); senão não há conta a conferir, e devolve `null`.
 */
function statusFromCitedScore(
  bet: Candidate,
  cited: { score: { first: number; second: number }; firstSide: "home" | "away" | null },
): string | null {
  const statusFor = (homeScore: number, awayScore: number) => {
    const resolution = resolveResultFromScore({
      mercado: bet.mercado, selecao: bet.selecao, evento: bet.evento, esporte: bet.esporte,
      homeScore, awayScore, odds: bet.odds, stake: bet.stake,
      scorePeriod: isRegulationTimeMarket(bet.mercado) ? "REGULATION" : "FT",
    });
    return resolution.ok ? resolution.status : null;
  };
  const { first, second } = cited.score;
  if (cited.firstSide === "home") return statusFor(first, second);
  if (cited.firstSide === "away") return statusFor(second, first);
  const status = statusFor(first, second);
  return status === statusFor(second, first) ? status : null;
}

function rawClaimedSourceUrl(data: unknown): unknown {
  return data && typeof data === "object" ? (data as { sourceUrl?: unknown }).sourceUrl : undefined;
}

export async function autoSettleGroundedIaJudgeSuggestion(params: {
  suggestionId: string;
  current: Candidate;
  confidence: number;
  valueFound: string;
  reason: string;
  sourceUrl: string;
  sourceDomain?: string | null;
  now: Date;
}): Promise<void> {
  try {
    const settled = await approveIaJudgeSuggestion({
      suggestionId: params.suggestionId,
      actor: "ia_judge_auto",
    });

    await resolveOperationalActionBySourceKey(
      "settlement.parado",
      params.current.id,
      "Liquidada automaticamente via IA-Judge",
      params.now,
    );

    try {
      await sendOperatorNotification(
        `🤖 ${emojiStatus(settled.status)} ${rotuloStatus(settled.status)} pela IA · ${params.current.evento}\n` +
        `${params.current.bankrollNome} · ${params.current.mercado} · ${params.current.selecao}\n` +
        `Certeza: ${Math.round(params.confidence * 100)}%\n` +
        `O que achou: ${params.valueFound}\n${params.reason}\n` +
        `Fonte: ${params.sourceDomain ? `${params.sourceDomain} · ` : ""}${params.sourceUrl}`,
        { key: `ia-judge-settlement:${params.suggestionId}` },
      );
    } catch (alertErr) {
      log.error(
        { err: alertErr, betId: params.current.id },
        "alerta IA-Judge auto-settle falhou",
      );
    }

    log.info(
      {
        betId: params.current.id,
        status: settled.status,
        confidence: params.confidence,
      },
      "IA-Judge: aposta liquidada automaticamente via approveIaJudgeSuggestion",
    );
  } catch (approveErr) {
    log.error(
      { err: approveErr, betId: params.current.id },
      "falha na auto-aprovação IA-Judge; mantendo sugestão aberta",
    );
  }
}

/**
 * As duas filas se alternam no lote: a das paradas (placar que o FlashScore
 * não fechou) não pode esperar a outra esvaziar. Fila que acaba cede a vez.
 */
function interleave(first: readonly Candidate[], second: readonly Candidate[], limit: number): Candidate[] {
  const picked = new Map<string, Candidate>();
  for (let index = 0; picked.size < limit && (index < first.length || index < second.length); index += 1) {
    for (const bet of [first[index], second[index]]) {
      if (bet && picked.size < limit && !picked.has(bet.id)) picked.set(bet.id, bet);
    }
  }
  return [...picked.values()];
}

export type IaJudgeCycleResult = {
  candidates: number;
  created: number;
  skipped: number;
  failed: number;
};

/** Um ciclo do cron: avalia até BATCH_SIZE candidatas. */
export async function runIaJudgeCycle(
  now = new Date(),
  options?: {
    includeStalled?: boolean;
    autoSettle?: boolean;
    /** Do job: abortado no prazo da rodada. As candidatas que faltam ficam para o ciclo seguinte. */
    signal?: AbortSignal;
  },
): Promise<IaJudgeCycleResult> {
  await dismissOrphanedIaJudgeSuggestions();
  // Quota global: avisa o operador e sai sem gastar mais chamadas.
  if (await isCooldownActive(QUOTA_KEY, now)) {
    log.warn("IA-Judge pausado — cooldown de quota");
    if (!(await isCooldownActive(QUOTA_NOTICE_KEY, now))) {
      await sendOperatorNotification(
        "⏸️ Liquidação por IA pausada\n" +
          "A cota do Gemini acabou. As apostas esperam e a IA volta sozinha " +
          `cerca de ${formatCooldownHours(QUOTA_COOLDOWN_MS)} depois da falha.`,
      );
      await setCooldown(QUOTA_NOTICE_KEY, QUOTA_COOLDOWN_MS, "quota_notice_sent", now);
    }
    return { candidates: 0, created: 0, skipped: 0, failed: 0 };
  }

  const [candidates, stalled] = await Promise.all([
    findIaJudgeCandidates(now),
    options?.includeStalled ? findStalledSettlementCandidates(now) : Promise.resolve([]),
  ]);

  const allCandidates = interleave(candidates, stalled, BATCH_SIZE);

  let created = 0;
  let skipped = 0;
  let failed = 0;
  let failedTransient = 0;

  for (const bet of allCandidates) {
    if (options?.signal?.aborted) {
      log.warn({ candidates: allCandidates.length, evaluated: created + skipped + failed },
        "ciclo IA-Judge interrompido no prazo — o resto fica para o próximo");
      break;
    }
    const r = await evaluateOne(bet, now, options);
    if (r === "created") created += 1;
    else if (r === "skipped") skipped += 1;
    else if (r === "failed_transient") { failed += 1; failedTransient += 1; }
    else failed += 1;
  }

  log.info({ candidates: allCandidates.length, created, skipped, failed }, "ciclo IA-Judge");

  if (failed === 0) {
    await reconcileOperationalActionSource("settlement.ia-judge", []);
  } else {
    await reportCycleFailures({ candidates: allCandidates.length, created, skipped, failed, failedTransient });
  }

  return { candidates: allCandidates.length, created, skipped, failed };
}

/**
 * Falhas por tip já têm FAILURE_COOLDOWN_MS; o alerta resume o lote. Ciclo em
 * que TODA falha foi transitória (LLM fora, cota) se fecha sozinho no próximo
 * ciclo bom; basta UMA falha real para o lote exigir revisão.
 */
async function reportCycleFailures(counts: {
  candidates: number;
  created: number;
  skipped: number;
  failed: number;
  failedTransient: number;
}): Promise<void> {
  const { candidates, created, skipped, failed, failedTransient } = counts;
  const soTransitorias = failedTransient === failed;
  try {
    await prisma.auditEvent.create({
      data: {
        action: "ia_judge.cycle_failure",
        actor: "system",
        resource: "ia-judge",
        outcome: soTransitorias ? "partial" : "error",
        details: { candidates, created, skipped, failed, failedTransient },
      },
    });
  } catch (e) {
    log.warn({ err: e }, "falha ao gravar auditEvent de cycle_failure");
  }

  await sendOperationalAlert(
    `⚠️ Liquidação por IA com falhas\n` +
      `${failed} de ${candidates} apostas falharam nesta rodada` +
      `${soTransitorias ? ", todas porque a IA estava fora do ar" : ""}` +
      ` (${created} sugestões criadas, ${skipped} puladas).\n` +
      `As que falharam tentam de novo em ${formatCooldownHours(FAILURE_COOLDOWN_MS)}.` +
      (soTransitorias ? "" : "\n👉 Se voltar no próximo ciclo, veja o log do IA-Judge; as apostas seguem liquidáveis à mão em Operações."),
    {
      source: "settlement.ia-judge",
      key: "cycle-failure",
      title: "Falhas no ciclo do IA-Judge",
      resource: "ia-judge",
      evidence: { candidates, created, skipped, failed, failedTransient },
      autoResolve: soTransitorias,
    },
  );
}
