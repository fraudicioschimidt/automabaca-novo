import { z } from "zod";

const summaryPlayerSchema = z.object({
  type: z.string().optional(),
  name: z.string().nullable().optional(),
  player_id: z.string().nullable().optional(),
  player_url: z.string().nullable().optional(),
}).passthrough();

const summaryEventSchema = z.object({
  minutes: z.union([z.string(), z.number()]).nullable().optional(),
  team: z.enum(["home", "away"]).nullable().optional(),
  players: z.array(summaryPlayerSchema).optional().default([]),
}).passthrough();

export const flashscoreSummaryResponseSchema = z.array(summaryEventSchema);
export type FlashscoreSummaryResponse = z.infer<typeof flashscoreSummaryResponseSchema>;

export type FlashscoreRegulationEvidence = {
  regulationScore: { home: number; away: number };
  aggregateScore: { home: number; away: number };
  goalEvents: number;
  extraTimeGoalEvents: number;
};

export type FlashscoreOrderedGoalsRefusal =
  | "summary_vazio"
  | "summary_incompleto"
  | "sem_gols"
  | "gols_nao_ordenados"
  | "gol_sem_jogador"
  | "gol_contra_envolvido";

export type FlashscoreOrderedGoals =
  | { ok: true; gols: import("@/src/domain/settlement/goalscorer").OrderedGoal[] }
  | { ok: false; reason: FlashscoreOrderedGoalsRefusal };

function regulationMinute(value: string | number | null | undefined): number | null {
  const raw = String(value ?? "").trim().replace(/[’']$/, "");
  const parsed = /^(\d{1,3})(?:\+\d{1,2})?$/.exec(raw);
  if (!parsed) return null;
  const base = Number(parsed[1]);
  return Number.isInteger(base) && base >= 1 && base <= 150 ? base : null;
}

function orderedMinute(value: string | number | null | undefined): {
  raw: string;
  order: number;
} | null {
  const raw = String(value ?? "").trim().replace(/[’']$/, "");
  const parsed = /^(\d{1,3})(?:\+(\d{1,2}))?$/.exec(raw);
  if (!parsed) return null;
  const base = Number(parsed[1]);
  const added = Number(parsed[2] ?? 0);
  if (!Number.isInteger(base) || base < 1 || base > 150) return null;
  return { raw, order: base * 100 + added };
}

function scoringType(value: string | undefined): "goal" | "own_goal" | null {
  const type = value?.trim().toLowerCase();
  if (type === "goal") return "goal";
  if (type === "own goal") return "own_goal";
  return null;
}

/**
 * Reconstrói 90' pelos eventos e só aceita o summary quando ele também explica
 * integralmente o placar agregado. Assim, evento ausente não vira um Under
 * falso e gol de prorrogação não entra silenciosamente no mercado regulamentar.
 */
export function resolveFlashscoreRegulationScore(params: {
  summary: FlashscoreSummaryResponse;
  listedScore: { home: number; away: number };
}): FlashscoreRegulationEvidence | null {
  if (params.summary.length === 0) return null;
  const aggregateScore = { home: 0, away: 0 };
  const regulationScore = { home: 0, away: 0 };
  let goalEvents = 0;
  let extraTimeGoalEvents = 0;

  for (const event of params.summary) {
    const scoring = event.players.flatMap((player) => {
      const type = scoringType(player.type);
      return type ? [type] : [];
    });
    if (scoring.length === 0) continue;
    if (scoring.length !== 1 || !event.team) return null;
    const minute = regulationMinute(event.minutes);
    if (minute === null) return null;
    const side = scoring[0] === "own_goal"
      ? (event.team === "home" ? "away" : "home")
      : event.team;
    aggregateScore[side] += 1;
    goalEvents += 1;
    if (minute <= 90) {
      regulationScore[side] += 1;
    } else {
      extraTimeGoalEvents += 1;
    }
  }

  if (
    aggregateScore.home !== params.listedScore.home ||
    aggregateScore.away !== params.listedScore.away
  ) return null;

  return { regulationScore, aggregateScore, goalEvents, extraTimeGoalEvents };
}

function fullNameFromPlayerUrl(value: string | null | undefined): string | null {
  const parts = value?.split("?")[0]?.split("/").filter(Boolean) ?? [];
  const slug = parts.length >= 2 ? parts.at(-2) : null;
  if (!slug || !/^[a-z0-9-]+$/i.test(slug)) return null;
  const name = slug.replace(/-+/g, " ").trim();
  return name || null;
}

/**
 * Extrai uma sequência financeira utilizável somente quando o summary explica
 * o placar inteiro e os minutos provam uma ordem estrita. Gol contra para aqui:
 * a convenção de First/Last varia por casa e não pode ser inventada.
 */
export function orderedGoalsFromFlashscoreSummary(params: {
  summary: FlashscoreSummaryResponse;
  listedScore: { home: number; away: number };
}): FlashscoreOrderedGoals {
  if (params.summary.length === 0) return { ok: false, reason: "summary_vazio" };
  if (!resolveFlashscoreRegulationScore(params)) {
    return { ok: false, reason: "summary_incompleto" };
  }

  const gols: import("@/src/domain/settlement/goalscorer").OrderedGoal[] = [];
  let previousOrder = -1;
  for (const event of params.summary) {
    const scoringPlayers = event.players.filter((player) => scoringType(player.type));
    if (scoringPlayers.length === 0) continue;
    const player = scoringPlayers[0];
    if (!player) return { ok: false, reason: "gol_sem_jogador" };
    if (scoringType(player.type) === "own_goal") {
      return { ok: false, reason: "gol_contra_envolvido" };
    }
    const minute = orderedMinute(event.minutes);
    if (!minute) return { ok: false, reason: "summary_incompleto" };
    if (minute.order <= previousOrder) {
      return { ok: false, reason: "gols_nao_ordenados" };
    }
    previousOrder = minute.order;
    const playerId = player.player_id?.trim();
    const shortName = player.name?.trim();
    const fullName = fullNameFromPlayerUrl(player.player_url) ?? shortName;
    if (!playerId || !fullName) return { ok: false, reason: "gol_sem_jogador" };
    gols.push({
      playerId,
      nome: fullName,
      ...(shortName && shortName !== fullName ? { nomeCurto: shortName } : {}),
      minuto: minute.raw,
      ordinal: gols.length + 1,
    });
  }
  return gols.length > 0 ? { ok: true, gols } : { ok: false, reason: "sem_gols" };
}
