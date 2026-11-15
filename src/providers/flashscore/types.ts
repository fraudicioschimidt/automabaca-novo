import { z } from "zod";

const singleTeamSchema = z.object({
  team_id: z.string(),
  name: z.string().min(1),
  short_name: z.string().nullable().optional(),
  red_cards: z.number().nullable().optional(),
});

/**
 * Em DUPLAS (tênis/beach), o feed manda os dois jogadores como ARRAY no lugar do
 * objeto de time — e o schema estrito derrubaria o catálogo inteiro do dia, não
 * só aquela partida, deixando a aposta sem modalidade confirmada. O par é
 * normalizado para um "time" único, que é como casa de aposta e Pinnacle
 * nomeiam duplas.
 */
const teamSchema = z.union([singleTeamSchema, z.array(singleTeamSchema).min(1)])
  .transform((value) => {
    if (!Array.isArray(value)) return value;
    const [first] = value;
    if (value.length === 1 && first) return first;
    return {
      team_id: value.map((player) => player.team_id).join("/"),
      name: value.map((player) => player.name).join(" / "),
      short_name: value.map((player) => player.short_name ?? player.name).join(" / "),
      red_cards: null,
    };
  });

const statusSchema = z.object({
  stage: z.string().nullable(),
  is_cancelled: z.boolean(),
  is_postponed: z.boolean(),
  is_started: z.boolean(),
  is_in_progress: z.boolean(),
  is_finished: z.boolean(),
  is_finished_after_extra_time: z.boolean().optional(),
  is_finished_after_penalties: z.boolean().optional(),
});

/**
 * Placar do fornecedor. Em boxe e MMA ele NÃO é placar: vem como string com o
 * método e o round — `("TKO/2", "TKO/2")`, `("points/8", "points/8")` —, igual
 * dos dois lados, porque descreve o desfecho da luta e não uma contagem.
 *
 * Com `z.number()` puro esses payloads reprovariam o schema, e como a validação
 * é do GRUPO inteiro, uma luta derrubaria o catálogo do dia daquele esporte —
 * mesmo mecanismo das duplas no tênis. Aqui a string
 * vira `null`: "não há placar utilizável" é a leitura correta e fail-closed, e
 * as outras partidas do dia sobrevivem.
 */
const placarLado = z
  .union([z.number().int().nonnegative(), z.string(), z.null()])
  .transform((valor) => (typeof valor === "number" ? valor : null));

const scoresSchema = z.object({
  home: placarLado,
  away: placarLado,
});

export const flashscoreMatchSchema = z.object({
  match_id: z.string().min(1),
  match_status: statusSchema,
  timestamp: z.number().int().positive(),
  home_team: teamSchema,
  away_team: teamSchema,
  scores: scoresSchema,
});

const tournamentGroupSchema = z.object({
  tournament_id: z.string().optional(),
  name: z.string().optional(),
  country_name: z.string().nullable().optional(),
  matches: z.array(flashscoreMatchSchema),
});

/** Partida do list-by-date que saiu do contrato e ficou fora do catálogo. */
export type FlashscoreRejectedMatch = { matchId: string | null; issues: z.core.$ZodIssue[] };

/**
 * Cada partida valida sozinha: validada junto com o grupo, uma partida fora do
 * contrato derrubava o catálogo do esporte×dia inteiro. A que reprova fica de
 * fora (não listada, fail-closed) e volta em `rejected`, para o cliente decidir
 * se foi uma linha ruim ou o contrato que mudou.
 */
export const flashscoreDateResponseSchema = z
  .array(tournamentGroupSchema.extend({ matches: z.array(z.unknown()) }))
  .transform((rawGroups) => {
    const rejected: FlashscoreRejectedMatch[] = [];
    const groups = rawGroups.map((group) => ({
      ...group,
      matches: group.matches.flatMap((row) => {
        const parsed = flashscoreMatchSchema.safeParse(row);
        if (parsed.success) return [parsed.data];
        const matchId = row && typeof row === "object" ? (row as { match_id?: unknown }).match_id : undefined;
        rejected.push({ matchId: typeof matchId === "string" ? matchId : null, issues: parsed.error.issues });
        return [];
      }),
    }));
    return { groups, rejected };
  });

const statValueSchema = z.union([z.number(), z.string(), z.null()]);
const statRowSchema = z.object({
  name: z.string(),
  home_team: statValueSchema,
  away_team: statValueSchema,
});

const statsObjectSchema = z.object({
  match: z.array(statRowSchema).optional().default([]),
  "1st-half": z.array(statRowSchema).optional(),
  "2nd-half": z.array(statRowSchema).optional(),
});

/**
 * SEM ESTATÍSTICA o feed devolve `[]` com HTTP 200 — comum no futebol. Tratar
 * isso como quebra de contrato deixaria a observação aberta, retentando para
 * sempre. Array VAZIO é resposta legítima ("não tenho estatística desta
 * partida"); array COM conteúdo continua fora do contrato e falha alto, porque
 * aí a forma mudou de verdade e adivinhar custaria liquidação errada.
 */
export const flashscoreStatsResponseSchema = z.preprocess(
  (value) => (Array.isArray(value) && value.length === 0 ? { match: [] } : value),
  statsObjectSchema,
);

export type FlashscoreMatch = z.infer<typeof flashscoreMatchSchema>;
export type FlashscoreTournamentGroup = z.infer<typeof tournamentGroupSchema>;
export type FlashscoreStatsResponse = z.infer<typeof flashscoreStatsResponseSchema>;
export type FlashscoreCatalogMatch = FlashscoreMatch & {
  tournament: {
    id: string | null;
    name: string | null;
    countryName: string | null;
  };
};

export function flattenFlashscoreMatches(
  groups: readonly FlashscoreTournamentGroup[],
): FlashscoreCatalogMatch[] {
  return groups.flatMap((group) =>
    group.matches.map((match) => ({
      ...match,
      tournament: {
        id: group.tournament_id ?? null,
        name: group.name ?? null,
        countryName: group.country_name ?? null,
      },
    })),
  );
}
