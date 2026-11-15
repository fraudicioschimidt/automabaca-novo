import { PLAYER_PROP_RULE_VERSION } from "@/src/domain/settlement/player-prop-rules";
import { matchTeamSide } from "@/src/domain/settlement/sides";
import { z } from "zod";
import { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/infra/prisma";
import { normalizeStr } from "@/src/domain/text";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";
import { runSerializableTransaction } from "@/src/services/shared/transaction";
import { applyManualBetStatusChangeTx, insertSettlementEventTx, type ApplyBetStatusChangeResult } from "@/src/services/bets/settle";
import { finishBetStatusChange } from "@/src/services/bets/settle-effects";
import type { PlayerPropTerms } from "@/src/domain/settlement/player-prop-terms";

type ValidationRow = { betId: string; payload: unknown; bet: { competicao: string; playerProp: { revision: number; rule: unknown; evidence: unknown } | null } };
function validationSummary(rows: ValidationRow[]) {
  const seen = new Set<string>();
  const latest = rows.filter((row) => { if (seen.has(row.betId)) return false; seen.add(row.betId); return true; });
  const current = latest.filter((row) => {
    const payload = row.payload as Record<string, unknown>;
    const prop = row.bet.playerProp;
    return prop && payload.revision === prop.revision && payload.ruleVersion === PLAYER_PROP_RULE_VERSION && (prop.rule as Record<string, unknown>).version === PLAYER_PROP_RULE_VERSION;
  });
  const approved = current.filter((row) => (row.payload as Record<string, unknown>).agrees === true && !(row.bet.playerProp?.evidence as Record<string, unknown> | null)?.correctionReview);
  const unexplained = current.some((row) => {
    const proof = row.bet.playerProp?.evidence as Record<string, unknown> | null;
    return (proof?.correctionReview || (row.payload as Record<string, unknown>).agrees === false) && !proof?.divergenceExplanation;
  });
  return { validatedBets: approved.length, validatedCompetitions: new Set(approved.map((row) => row.bet.competicao).filter(Boolean)).size, unexplained };
}
const validationBetSelect = { competicao: true, bankrollId: true, playerProp: { select: { revision: true, rule: true, evidence: true } } } as const;

export async function getPlayersPanel(search = "") {
  const query = z.string().trim().max(150).parse(search);
  const [players, pending, bankrolls, validations, corrections] = await Promise.all([
    prisma.playerIdentity.findMany({ where: query ? { OR: [{ canonicalName: { contains: query, mode: "insensitive" } }, { aliases: { some: { normalizedName: { contains: normalizeStr(query) } } } }] } : {}, take: 100, orderBy: { canonicalName: "asc" }, include: { aliases: true } }),
    prisma.betPlayerProp.findMany({ where: { bet: { status: "PENDING", deletedAt: null } }, take: 100, orderBy: { createdAt: "desc" }, include: { bet: { select: { evento: true, selecao: true, competicao: true, bankrollId: true } } } }),
    prisma.bankroll.findMany({ select: { id: true, nome: true, sharpMode: true, imageStakeAsUnits: true, playerPropsAutoSettlement: true }, orderBy: { nome: "asc" } }),
    prisma.settlementEvent.findMany({ where: { type: "PLAYER_PROP_VALIDATION", bet: { deletedAt: null } }, orderBy: { createdAt: "desc" }, select: { betId: true, payload: true, bet: { select: validationBetSelect } } }),
    prisma.betPlayerProp.findMany({ where: { bet: { deletedAt: null }, OR: [{ evidence: { path: ["correctionReview"], equals: true } }, { evidence: { path: ["validationDisagreement"], equals: true } }] }, take: 100, include: { bet: { select: { evento: true, selecao: true, status: true } } } }),
  ]);
  const appearances = await prisma.playerMatchAppearance.findMany({ where: { providerMatchId: { in: pending.flatMap((p) => p.providerMatchId ? [p.providerMatchId] : []) }, confirmed: true }, include: { playerIdentity: true } });
  return {
    players: players.map((p) => ({ id: p.id, name: p.canonicalName, providerPlayerId: p.providerPlayerId, aliases: p.aliases.map((a) => ({ id: a.id, name: a.name, provider: a.provider, source: a.source })) })),
    pending: pending.map((p) => ({ betId: p.betId, ...p.bet, terms: p.terms as unknown as PlayerPropTerms, identityId: p.playerIdentityId, evidence: p.evidence as Record<string, unknown> | null,
      candidates: appearances.filter((a) => a.providerMatchId === p.providerMatchId).map((a) => ({ id: a.playerIdentityId, name: a.playerIdentity.canonicalName, teamId: a.providerTeamId })),
    })),
    corrections: corrections.map((p) => ({ betId: p.betId, ...p.bet, evidence: p.evidence as Record<string, unknown> })),
    bankrolls: bankrolls.map((b) => ({ ...b, ...validationSummary(validations.filter((v) => v.bet.bankrollId === b.id)) })),
  };
}

const commandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("acknowledge"), betId: z.string().uuid(), evidence: z.string().trim().min(10).max(1000) }),
  z.object({ kind: z.literal("link"), betId: z.string().uuid(), playerIdentityId: z.string().uuid() }),
  z.object({ kind: z.literal("removeAlias"), aliasId: z.string().uuid() }),
  z.object({ kind: z.literal("result"), betId: z.string().uuid(), status: z.enum(["WON", "LOST", "VOID"]), evidence: z.string().trim().min(5).max(1000) }),
  z.object({ kind: z.literal("settings"), bankrollId: z.string().uuid(), imageStakeAsUnits: z.boolean(), automatic: z.boolean() }),
]);
export type PlayerPanelCommand = z.infer<typeof commandSchema>;

export async function applyPlayerPanelCommand(raw: PlayerPanelCommand, actor: string): Promise<void> {
  const command = commandSchema.parse(raw);
  const settled = await runSerializableTransaction("player.curate", async (tx) => {
    let result: ApplyBetStatusChangeResult | null = null;
    if (command.kind === "settings") {
      if (command.automatic) {
        const samples = await tx.settlementEvent.findMany({ where: { type: "PLAYER_PROP_VALIDATION", bet: { bankrollId: command.bankrollId, deletedAt: null } }, orderBy: { createdAt: "desc" }, include: { bet: { select: validationBetSelect } } });
        const summary = validationSummary(samples);
        if (summary.unexplained || summary.validatedBets < 20 || summary.validatedCompetitions < 3) throw new RecusaDeNegocioError("A ativação exige 20 apostas conferidas em três competições, sem divergências pendentes.");
      }
      await tx.bankroll.update({ where: { id: command.bankrollId }, data: { imageStakeAsUnits: command.imageStakeAsUnits, playerPropsAutoSettlement: command.automatic } });
    } else if (command.kind === "acknowledge") {
      const prop = await tx.betPlayerProp.findUniqueOrThrow({ where: { betId: command.betId } });
      const before = prop.evidence as Record<string, unknown> | null;
      await tx.betPlayerProp.update({ where: { betId: prop.betId }, data: { evidence: { ...before, correctionReview: false, validationDisagreement: false, divergenceExplanation: command.evidence } as Prisma.InputJsonValue } });
      await insertSettlementEventTx(tx, { betId: prop.betId, type: "PLAYER_PROP_DIVERGENCE_REVIEWED", payload: { actor, explanation: command.evidence, previous: before } });
    } else if (command.kind === "result") {
      const prop = await tx.betPlayerProp.findUniqueOrThrow({ where: { betId: command.betId }, include: { bet: true } });
      if (prop.bet.deletedAt || prop.bet.status !== "PENDING") throw new RecusaDeNegocioError("Esta aposta não está mais pendente.");
      const evidence = prop.evidence as Record<string, unknown> | null;
      // O CAS é o `status !== "PENDING"` acima, lido nesta transação serializável:
      // outra liquidação entre a leitura e a escrita aborta esta, e a nova
      // tentativa relê o status e para no erro de aposta não pendente.
      result = await applyManualBetStatusChangeTx(tx, { betId: prop.betId, newStatus: command.status, source: `manual:${actor}`, requirePending: true });
      await insertSettlementEventTx(tx, { betId: prop.betId, type: "PLAYER_PROP_VALIDATION", payload: {
        status: command.status, source: command.evidence, actor,
        agrees: evidence?.proposedStatus ? evidence.proposedStatus === command.status : null,
        proposal: evidence?.proposedStatus ?? null, revision: prop.revision, ruleVersion: (prop.rule as Record<string, unknown>).version,
      } });
      if (evidence?.proposedStatus && evidence.proposedStatus !== command.status) await tx.betPlayerProp.update({ where: { betId: prop.betId }, data: { evidence: { ...evidence, validationDisagreement: true } as Prisma.InputJsonValue } });
    } else {
      let affected: string[] = [];
      if (command.kind === "link") {
        const prop = await tx.betPlayerProp.findUniqueOrThrow({ where: { betId: command.betId }, include: { bet: true } });
        if (prop.bet.status !== "PENDING" || prop.bet.deletedAt) throw new RecusaDeNegocioError("Só apostas pendentes podem receber identidade.");
        if (!prop.providerMatchId) throw new RecusaDeNegocioError("Identifique a partida antes de vincular o jogador.");
        const appearance = await tx.playerMatchAppearance.findUnique({ where: { playerIdentityId_providerMatchId: { playerIdentityId: command.playerIdentityId, providerMatchId: prop.providerMatchId } } });
        if (!appearance?.confirmed) throw new RecusaDeNegocioError("Jogador sem escalação confirmada nesta partida.");
        const terms = prop.terms as unknown as PlayerPropTerms;
        const proof = prop.evidence as { teams?: { swapped: boolean } } | null;
        if (terms.time) {
          const side = matchTeamSide(terms.time, prop.bet.evento);
          const providerSide = proof?.teams ? (proof.teams.swapped ? side === "home" ? "away" : side === "away" ? "home" : null : side) : null;
          if (!providerSide || appearance.side !== providerSide) throw new RecusaDeNegocioError("Jogador incompatível com o time informado no bilhete.");
        }
        const normalizedName = normalizeStr(terms.jogador);
        await tx.playerProviderAlias.upsert({
          where: { playerIdentityId_provider_normalizedName: { playerIdentityId: command.playerIdentityId, provider: "LOCAL", normalizedName } },
          create: { playerIdentityId: command.playerIdentityId, provider: "LOCAL", name: terms.jogador, normalizedName, source: "MANUAL", confidence: 100 },
          update: { source: "MANUAL", confidence: 100 },
        });
        const related = await tx.betPlayerProp.findMany({ where: { terms: { path: ["jogador"], equals: terms.jogador }, bet: { status: "PENDING", deletedAt: null } }, select: { betId: true } });
        await tx.betPlayerProp.updateMany({ where: { betId: { in: related.map((p) => p.betId) } }, data: { playerIdentityId: null } });
        affected = related.map((p) => p.betId);
        await tx.betPlayerProp.update({ where: { betId: prop.betId }, data: { playerIdentityId: command.playerIdentityId } });
      } else {
        const alias = await tx.playerProviderAlias.findUniqueOrThrow({ where: { id: command.aliasId } });
        if (alias.provider !== "LOCAL") throw new RecusaDeNegocioError("O nome original do Flashscore não pode ser removido.");
        const related = await tx.betPlayerProp.findMany({ where: { playerIdentityId: alias.playerIdentityId, bet: { status: "PENDING", deletedAt: null } }, select: { betId: true } });
        affected = related.map((p) => p.betId);
        await tx.playerProviderAlias.delete({ where: { id: alias.id } });
        await tx.betPlayerProp.updateMany({ where: { betId: { in: affected } }, data: { playerIdentityId: null } });
      }
      await tx.betPlayerProp.updateMany({ where: { betId: { in: affected } }, data: { evidence: Prisma.DbNull, revision: { increment: 1 }, resolutionStatus: "PENDING" } });
      await tx.betResult.updateMany({ where: { betId: { in: affected } }, data: { resultFinal: false, resultCheckedAt: null } });
    }
    await tx.auditEvent.create({ data: { actor, action: `player.${command.kind}`, resource: "player", details: command } });
    return result;
  });
  // Mesmos efeitos pós-commit de toda liquidação: cancela o sharp.enrich
  // pendente e avisa a liquidação sem conta.
  if (settled && command.kind === "result") await finishBetStatusChange(command.betId, settled);
}
