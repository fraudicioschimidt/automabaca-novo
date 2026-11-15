import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  delegatedSettlementActor,
  delegatedSettlementInputSchema,
  delegatedSettlementPlanHash,
  delegatedSettlementRequestId,
} from "@/src/domain/delegated-settlement";
import { actorDisplayName, classifyAuditActor, classifySettlementSource } from "@/src/domain/production-write-actors";

const betId = "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const item = { betId, newStatus: "WON", evidence: "Placar oficial 2x1 no FlashScore." };
const plan = {
  version: 1 as const, agent: "antigravity", approvedBy: "operador", createdAt: "2026-09-15T12:00:00.000Z",
  items: [{ betId, bankrollSlug: "banca", newStatus: "WON" as const, expectedVersion: 1, evidence: item.evidence,
    preview: { evento: "A vs B", mercado: "Money Line – Match", selecao: "A", data: "2026-09-14T20:00:00.000Z", odds: 2, stake: 1, lucroPrevisto: 1 } }],
};

describe("contrato da liquidação delegada", () => {
  it("exige evidência, agente nomeado e aposta única por lote", () => {
    expect(delegatedSettlementInputSchema.safeParse({ agent: "antigravity", approvedBy: "operador", items: [item] }).success).toBe(true);
    expect(delegatedSettlementInputSchema.safeParse({ agent: "antigravity", approvedBy: "operador", items: [{ ...item, evidence: "ok" }] }).success).toBe(false);
    expect(delegatedSettlementInputSchema.safeParse({ agent: "Antigravity Gemini", approvedBy: "operador", items: [item] }).success).toBe(false);
    expect(delegatedSettlementInputSchema.safeParse({ agent: "antigravity", approvedBy: "operador", items: [item, item] }).success).toBe(false);
  });

  it.each(["PENDING", "CASHOUT", "CANCELED"])("não aceita %s: só resultado final sem valor livre", (newStatus) => {
    expect(delegatedSettlementInputSchema.safeParse({ agent: "antigravity", approvedBy: "operador", items: [{ ...item, newStatus }] }).success).toBe(false);
  });

  it("o hash muda com qualquer decisão do plano", () => {
    const base = delegatedSettlementPlanHash(plan);
    expect(delegatedSettlementPlanHash(structuredClone(plan))).toBe(base);
    expect(delegatedSettlementPlanHash({ ...plan, items: [{ ...plan.items[0]!, newStatus: "LOST" }] })).not.toBe(base);
    expect(delegatedSettlementPlanHash({ ...plan, approvedBy: "outro" })).not.toBe(base);
  });

  it("requestId é UUID válido, estável por plano e aposta", () => {
    const id = delegatedSettlementRequestId("a".repeat(64), betId);
    expect(z.uuid().safeParse(id).success).toBe(true);
    expect(delegatedSettlementRequestId("a".repeat(64), betId)).toBe(id);
    expect(delegatedSettlementRequestId("b".repeat(64), betId)).not.toBe(id);
  });

  it("o ator registra quem executou e a pedido de quem", () => {
    const actor = delegatedSettlementActor("antigravity", "operador");
    expect(actor).toBe("agent:antigravity:por:operador");
    expect(classifyAuditActor(actor, new Set(["operador"]))).toBe("delegated");
  });
});

describe("a homologação do IA-Judge pelo agente", () => {
  it("ia-judge:agent:<nome>:por:<dono do painel> é escrita a pedido do dono; com dono inventado, sem autor", () => {
    const painel = new Set(["fabricio"]);
    expect(classifySettlementSource("ia-judge:agent:gemini:por:fabricio", painel)).toBe("delegated");
    expect(classifySettlementSource("ia-judge:agent:gemini:por:alguem", painel)).toBe("unattributed");
  });
});

describe("o ator na tela", () => {
  it("o agente delegado aparece com o robô e o dono; o resto, como foi gravado", () => {
    expect(actorDisplayName("agent:gemini:por:fabricio")).toBe("🤖 Gemini (por Fabricio)");
    expect(actorDisplayName("fabricio")).toBe("fabricio");
    expect(actorDisplayName("telegram-channel:gemini-vision")).toBe("telegram-channel:gemini-vision");
  });
});

describe("origem das escritas em produção", () => {
  const painel = new Set(["operador"]);

  it.each([
    "system", "system:closing-series", "worker", "sport-resolver", "ia_judge_auto", "telegram-channel",
    "telegram-channel:gemini-vision", "telegram-channel:auto-bankroll", "telegram-reaction", "telegram-user:12345",
    "deployment-verification", "c18-deployment-verification",
  ])("%s é fluxo automático", (actor) => {
    expect(classifyAuditActor(actor, painel)).toBe("automatic");
  });

  it.each(["operator", "auto-healer", "auto-curadoria:recalibracao", "codex:user-request:x", "agent:x", "telegram-edit"])(
    "%s não tem autoria declarada", (actor) => {
      expect(classifyAuditActor(actor, painel)).toBe("unattributed");
    },
  );

  it.each(["agent:claude:por:admin", "agent:claude:por:<dono>", "agent:claude:por:operador2"])(
    "%s: operador que não é usuário do painel não conta como pedido dele", (actor) => {
      expect(classifyAuditActor(actor, painel)).toBe("unattributed");
    },
  );

  it("operador do painel não entra na revisão, nome parecido entra", () => {
    expect(classifyAuditActor("operador", painel)).toBe("operator");
    expect(classifyAuditActor("operador2", painel)).toBe("unattributed");
  });

  it.each([
    ["flashscore", "automatic"], ["telegram-edit", "unattributed"], ["ia-judge:ia_judge_auto", "automatic"],
    ["sport-resolver", "automatic"], ["telegram-dm", "unattributed"], ["system", "unattributed"],
    ["manual:operador", "operator"], ["ia-judge:operador", "operator"],
    ["manual:operator", "unattributed"], ["operator", "unattributed"], ["operator:audit:Auditado", "unattributed"],
  ] as const)("fonte de liquidação %s → %s", (source, expected) => {
    expect(classifySettlementSource(source, painel)).toBe(expected);
  });
});
