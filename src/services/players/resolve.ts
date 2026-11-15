import { prisma } from "@/src/infra/prisma";
import { normalizeStr } from "@/src/domain/text";
import { encontrarJogadorNaPartida, type JogadorDaPartida } from "@/src/domain/settlement/goalscorer-matching";
import type { PlayerAppearance } from "@/src/providers/flashscore/lineups";

export async function resolvePlayerIdentity(params: {
  selection: string; playerName: string; matchId: string; sport: string;
  players: readonly JogadorDaPartida[]; appearances: readonly PlayerAppearance[];
  now: Date;
}) {
  const byProviderId = new Map<string, string>();
  for (const player of params.players) {
    const identity = await prisma.playerIdentity.upsert({
      where: { provider_providerPlayerId_sport: { provider: "flashscore", providerPlayerId: player.playerId, sport: params.sport } },
      create: { providerPlayerId: player.playerId, sport: params.sport, canonicalName: player.nome },
      update: {},
    });
    // Provider IDs survive transfers and name display changes. Prefer the full
    // published name over an earlier abbreviated lineup name.
    if (player.nome.length > identity.canonicalName.length && /(?:\b[A-Za-z]\.|^.$)/.test(identity.canonicalName)) {
      await prisma.playerIdentity.update({ where: { id: identity.id }, data: { canonicalName: player.nome } });
    }
    byProviderId.set(player.playerId, identity.id);
    await prisma.playerProviderAlias.upsert({
      where: { playerIdentityId_provider_normalizedName: { playerIdentityId: identity.id, provider: "FLASHSCORE", normalizedName: normalizeStr(player.nome) } },
      create: { playerIdentityId: identity.id, provider: "FLASHSCORE", name: player.nome, normalizedName: normalizeStr(player.nome), source: "AUTO", confidence: 100 },
      update: {},
    });
    const appearance = params.appearances.find((a) => a.playerId === player.playerId);
    if (appearance) await prisma.playerMatchAppearance.upsert({
      where: { playerIdentityId_providerMatchId: { playerIdentityId: identity.id, providerMatchId: params.matchId } },
      create: { playerIdentityId: identity.id, providerMatchId: params.matchId, providerTeamId: appearance.teamId, side: appearance.side, confirmed: appearance.confirmed, evidence: appearance, observedAt: params.now },
      update: { providerTeamId: appearance.teamId, side: appearance.side, confirmed: appearance.confirmed, evidence: appearance, observedAt: params.now },
    });
  }
  const aliases = await prisma.playerProviderAlias.findMany({
    where: { normalizedName: normalizeStr(params.playerName), provider: "LOCAL", playerIdentityId: { in: [...byProviderId.values()] } },
    select: { playerIdentityId: true },
  });
  const ids = new Set(aliases.map((a) => a.playerIdentityId));
  const aliased = params.players.filter((p) => ids.has(byProviderId.get(p.playerId) ?? ""));
  if (aliased.length > 1) return { ok: false as const, reason: "jogador_ambiguo", candidatos: aliased.map((p) => p.nome) };
  const selected = aliased[0];
  const result = selected
    ? { ok: true as const, jogador: selected, similaridade: 1, vantagem: 1 }
    : encontrarJogadorNaPartida(params.playerName, params.players);
  if (!result.ok) return result;
  const identityId = byProviderId.get(result.jogador.playerId);
  if (!identityId) throw new Error("Identidade do jogador não persistida.");
  // Learn only exact full-name matches. Fuzzy matches never become permanent aliases.
  if (!selected && result.similaridade === 1 && result.vantagem >= 0.15) {
    await prisma.playerProviderAlias.upsert({
      where: { playerIdentityId_provider_normalizedName: { playerIdentityId: identityId, provider: "LOCAL", normalizedName: normalizeStr(params.playerName) } },
      create: { playerIdentityId: identityId, provider: "LOCAL", name: params.playerName, normalizedName: normalizeStr(params.playerName), source: "AUTO", confidence: 100 },
      update: {},
    });
  }
  return { ...result, identityId, source: selected ? "ALIAS" : "NAME" };
}
