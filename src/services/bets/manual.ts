import { z } from "zod";
import { canonicalSha256 } from "@/src/domain/canonical-json";
import { normalizeManualBetInput, type ManualBetInput } from "@/src/domain/manual-bet";
import { SPORT_RESOLVER_VERSION } from "@/src/domain/sports/detect";
import { getSharedBoss } from "@/src/infra/boss";
import { createLogger } from "@/src/infra/logger";
import { sendOperationalAlert } from "@/src/services/ops/alerts";
import { cancelPendingSharpEnrich, enqueueSharpEnrich } from "@/src/services/scheduling/enqueue-enrich";
import { applyBetEdit } from "@/src/services/bets/edit";
import { registerBet } from "@/src/services/bets/register";
import { canonicalizeBetForRegistration } from "@/src/services/bets/canonicalize-registration";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";

const log = createLogger("bets-manual");

/** Falha de fila após commit preserva a aposta e registra recuperação operacional. */
async function scheduleManualEnrich(betId: string, evento: string, edited: boolean): Promise<void> {
  try {
    const boss = await getSharedBoss();
    if (edited) await cancelPendingSharpEnrich(boss, betId);
    await enqueueSharpEnrich(boss, betId, edited ? { origem: "web-edit" } : undefined);
  } catch (err) {
    log.error({ err, betId, edited }, "falha ao enfileirar sharp.enrich após alteração manual");
    await sendOperationalAlert(
      edited
        ? `⚠️ Aposta editada sem busca de preço · ${evento}\nA aposta foi salva, mas a busca na Pinnacle não entrou na fila.\n👉 Reprocesse em Operações.`
        : `⚠️ Aposta manual sem busca de preço · ${evento}\nA aposta foi salva, mas a busca na Pinnacle não entrou na fila.\n👉 Reprocesse em Operações.`,
      {
        source: edited ? "bets.edit-enrich-enqueue" : "bets.manual-enrich-enqueue",
        key: betId,
        title: edited ? "Aposta editada sem enriquecimento enfileirado" : "Tip manual sem enriquecimento enfileirado",
        resource: "bet",
        resourceId: betId,
        autoResolve: false,
      },
    );
  }
}

function sportEvidence(esporte: string, edited: boolean) {
  return [{
    source: "MANUAL" as const,
    sport: esporte,
    confidence: 100,
    value: edited ? "correção do operador" : "seleção do operador",
  }];
}

/**
 * O que a normalização recusa (mandante vazio, odd ≤ 1, data inválida) é erro
 * de preenchimento do operador: vira recusa de negócio, com a mensagem até a
 * tela.
 */
function normalizeOrRefuse(input: ManualBetInput) {
  try {
    return normalizeManualBetInput(input);
  } catch (error) {
    throw new RecusaDeNegocioError(error instanceof Error ? error.message : String(error));
  }
}

export async function registerManualBet(bankrollId: string, input: ManualBetInput, actor: string, requestId?: string) {
  if (requestId !== undefined && !z.uuid().safeParse(requestId).success) throw new RecusaDeNegocioError("Identificador de criação inválido. Abra um novo formulário.");
  const fields = normalizeOrRefuse(input);
  // O registro não canoniza: país, DNB, dupla chance e os nomes que o dono treinou saem daqui, como a captura faz na preparação.
  const canonical = await canonicalizeBetForRegistration(fields);
  const registered = await registerBet({
    ...canonical,
    bankrollId,
    sportResolutionStatus: "CONFIRMED",
    sportConfidence: 100,
    sportSource: "MANUAL",
    sportEvidence: sportEvidence(fields.esporte, false),
    sportResolverVersion: SPORT_RESOLVER_VERSION,
    source: "web-manual",
    // O recibo do pedido é do pedido com estes dados: o reenvio idêntico cai na
    // mesma aposta, e o formulário corrigido depois de um "já cadastrada" é outra.
    ...(requestId ? { sourceExternalId: canonicalSha256({ requestId: requestId.toLowerCase(), bankrollId, ...fields, data: fields.data.toISOString() }) } : {}),
    actor,
  });
  if (registered.created) await scheduleManualEnrich(registered.betId, fields.evento, false);
  return registered;
}

/**
 * `expectedVersion`: a revisão da aposta que a ficha mostrava ao abrir.
 * `requiresEnrich`: a edição descartou o jogo casado e a aposta volta para a análise.
 */
export async function editManualBet(
  betId: string,
  input: ManualBetInput,
  actor: string,
  expectedVersion: number,
): Promise<{ requiresEnrich: boolean }> {
  const fields = normalizeOrRefuse(input);
  const edit = await applyBetEdit({
    financialAuthority: "operator",
    expectedVersion,
    betId,
    fields,
    actor,
    sportResolution: {
      status: "CONFIRMED",
      confidence: 100,
      source: "MANUAL",
      evidence: sportEvidence(fields.esporte, true),
      resolverVersion: SPORT_RESOLVER_VERSION,
    },
  });
  if (edit.requiresEnrich) await scheduleManualEnrich(betId, fields.evento, true);
  return { requiresEnrich: edit.requiresEnrich };
}
