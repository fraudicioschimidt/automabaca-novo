import { z } from "zod";
import type { JogadorDaPartida } from "@/src/domain/settlement/goalscorer-matching";

const person = z.object({
  player_id: z.string().min(1), name: z.string().min(1),
  substitutionMinute: z.string().nullish(),
  replacedPlayer: z.object({ player_id: z.string().min(1) }).passthrough().nullish(),
}).passthrough();
export const flashscoreLineupsSchema = z.array(z.object({
  side: z.string(),
  startingLineups: z.array(person).nullish(),
  substitutes: z.array(person).nullish(),
  substitutedPlayers: z.array(person).nullish(),
  missingPlayers: z.array(person).nullish(),
  predictedLineups: z.array(person).nullish(),
}).passthrough());
export type FlashscoreLineups = z.infer<typeof flashscoreLineupsSchema>;
export type PlayerAppearance = {
  playerId: string; nome: string; teamId: string; side: "home" | "away";
  titular: boolean | null; participou: boolean; substituido?: boolean;
  confirmed: boolean;
};

/** Predicted lineups are deliberately excluded from money-deciding evidence. */
export function normalizePlayerAppearances(
  lineups: FlashscoreLineups,
  teams: { home: string; away: string },
): PlayerAppearance[] {
  const out: PlayerAppearance[] = [];
  for (const group of lineups) {
    const rawSide = group.side.toLowerCase();
    if (rawSide !== "home" && rawSide !== "away") continue;
    const side = rawSide;
    const starters = group.startingLineups ?? [];
    // Football contract: abbreviated/small-sided or partial lineups are not proof.
    const confirmed = starters.length === 11 && new Set(starters.map((p) => p.player_id)).size === 11;
    const startersIds = new Set(starters.map((p) => p.player_id));
    const replacements = group.substitutedPlayers ?? [];
    const removed = new Set(replacements.map((p) => p.replacedPlayer?.player_id).filter(Boolean));
    const entered = new Set(replacements.map((p) => p.player_id));
    const seen = new Set<string>();
    for (const p of [...starters, ...(group.substitutes ?? []), ...replacements, ...(group.missingPlayers ?? [])]) {
      if (seen.has(p.player_id)) continue;
      seen.add(p.player_id);
      out.push({
        playerId: p.player_id, nome: p.name, teamId: teams[side], side,
        titular: confirmed ? startersIds.has(p.player_id) : null,
        participou: confirmed && (startersIds.has(p.player_id) || entered.has(p.player_id)),
        ...(removed.has(p.player_id) ? { substituido: true } : confirmed && Array.isArray(group.substitutedPlayers) ? { substituido: false } : {}), confirmed,
      });
    }
  }
  if (new Set(out.map((p) => p.playerId)).size !== out.length) throw new Error("Jogador publicado nos dois times da partida.");
  return out;
}

export function mergePlayerAppearances(
  stats: readonly JogadorDaPartida[], appearances: readonly PlayerAppearance[],
): JogadorDaPartida[] {
  const ids = new Set(stats.map((p) => p.playerId));
  const merged = stats.map((p) => {
    const a = appearances.find((row) => row.playerId === p.playerId);
    if (a && p.teamId && p.teamId !== a.teamId) throw new Error("Jogador com times divergentes entre escalação e estatísticas.");
    return a ? { ...p, teamId: a.teamId, titular: a.titular ?? p.titular, participou: a.participou || (p.minutosJogados ?? 0) > 0, substituido: a.substituido } : p;
  });
  return [...merged, ...appearances.filter((a) => !ids.has(a.playerId)).map((a) => ({
    ...a, gols: 0, golsContra: 0, stats: {},
  }))];
}
