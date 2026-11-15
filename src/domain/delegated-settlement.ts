import { z } from "zod";
import { canonicalSha256 } from "@/src/domain/canonical-json";
import { SETTLEMENT_MANUAL_BATCH_MAX } from "@/src/domain/settlement/manual-batch";

/**
 * Liquidação delegada: o dono pede a um agente que liquide apostas por ele.
 *
 * Script avulso chamando o serviço de settlement direto não confere a versão
 * vista, não deixa recibo e grava com a identidade do dono ou um ator inventado.
 * Aqui o agente gera um PLANO (sem gravar), o plano tem hash, e só o plano com
 * aquele hash é aplicado, pelo mesmo caminho com recibo usado pelo painel, com
 * quem executou e a evidência de cada item.
 */

/** Só para frente e sem valor livre: CASHOUT exige lucro informado, CANCELED é exclusão. */
export const DELEGATED_SETTLEMENT_STATUSES = ["WON", "LOST", "VOID", "HALF_WON", "HALF_LOST"] as const;

const agentName = z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, "agente: minúsculas, dígitos e hífen (2–40)");
const username = z.string().trim().min(1).max(80);

export const delegatedSettlementInputSchema = z.object({
  agent: agentName,
  approvedBy: username,
  items: z.array(z.object({
    betId: z.uuid(),
    newStatus: z.enum(DELEGATED_SETTLEMENT_STATUSES),
    /** O que foi conferido e onde: placar, estatística, fonte. Obrigatório. */
    evidence: z.string().trim().min(10).max(500),
    evidenceUrl: z.url().max(500).optional(),
  }).strict()).min(1).max(SETTLEMENT_MANUAL_BATCH_MAX),
}).strict().refine(
  (input) => new Set(input.items.map((item) => item.betId)).size === input.items.length,
  "cada aposta pode aparecer uma única vez no lote",
);

export const delegatedSettlementPlanItemSchema = z.object({
  betId: z.uuid(),
  bankrollSlug: z.string().min(1),
  newStatus: z.enum(DELEGATED_SETTLEMENT_STATUSES),
  expectedVersion: z.number().int().positive(),
  evidence: z.string().min(10).max(500),
  evidenceUrl: z.url().max(500).optional(),
  /** Só para revisão humana: não participam de nenhuma decisão na aplicação. */
  preview: z.object({
    evento: z.string(), mercado: z.string(), selecao: z.string(), data: z.string(),
    odds: z.number(), stake: z.number(), lucroPrevisto: z.number(),
  }).strict(),
}).strict();

export const delegatedSettlementPlanSchema = z.object({
  version: z.literal(1),
  agent: agentName,
  approvedBy: username,
  createdAt: z.iso.datetime(),
  items: z.array(delegatedSettlementPlanItemSchema).min(1).max(SETTLEMENT_MANUAL_BATCH_MAX),
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type DelegatedSettlementPlan = z.infer<typeof delegatedSettlementPlanSchema>;
export type DelegatedSettlementPlanItem = z.infer<typeof delegatedSettlementPlanItemSchema>;

/** Hash de tudo o que o plano decide; editar qualquer campo invalida a aprovação. */
export function delegatedSettlementPlanHash(plan: Omit<DelegatedSettlementPlan, "planHash">): string {
  return canonicalSha256({
    version: plan.version, agent: plan.agent, approvedBy: plan.approvedBy,
    createdAt: plan.createdAt, items: plan.items,
  });
}

/**
 * `requestId` estável por (plano, aposta): reaplicar o mesmo plano cai no recibo
 * existente em vez de liquidar de novo. Formato UUID v8 (conteúdo derivado).
 */
export function delegatedSettlementRequestId(planHash: string, betId: string): string {
  const hex = canonicalSha256({ planHash, betId }).slice(0, 32).split("");
  hex[12] = "8";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Ator da auditoria: quem executou, a pedido de quem. Nunca o nome do dono sozinho. */
export function delegatedSettlementActor(agent: string, approvedBy: string): string {
  return `agent:${agent}:por:${approvedBy}`;
}
