import { spDayKey } from "@/src/domain/dates";
import { teamAliasNameProblem } from "@/src/domain/team-alias-name";
import { hasTeamProviderCountryConflict } from "@/src/domain/team-provider-context";
import { canonicalizeTeamName, normalizeStr, teamIdentityCategoryConflict, teamNameEvidence } from "@/src/domain/text";
import type { Prisma } from "@/src/generated/prisma/client";
import { createLogger } from "@/src/infra/logger";
import { recordOperationalMetric } from "@/src/infra/operational-metrics";
import { prisma } from "@/src/infra/prisma";
import { runSerializableTransaction } from "@/src/services/shared/transaction";
import { findUsableCatalogLink, type UsableCatalogLink } from "./catalog-links";
import { teamCardCategory } from "./catalog-pairing";

/**
 * O nome que o tipster usou para o time, gravado na ficha dele. Ensinam a
 * identidade AUTOMÁTICA e o Vincular (o dono ou o agente dele); o juiz de IA
 * decide só a aposta.
 *
 * A identidade automática ensina só pelo jogo ligado no pareamento dos
 * catálogos: o lado do evento da Pinnacle17 leva ao id do FlashScore, e o id à
 * ficha. Sem ligação ainda, o nome espera a rodada do pareamento que ligar o
 * jogo (`team_tipster_name_waits`); o nome nunca é adivinhado.
 *
 * O nome nasce `pending` e vira `confirmed` quando volta, na mesma ficha, noutro
 * evento da Pinnacle17, noutra aposta e noutro dia de São Paulo: o jogo adiado,
 * a edição que refaz a identidade e o horário velho da Bridge não confirmam. E
 * só confirma se nenhuma outra ficha do mesmo esporte, país e categoria tem o
 * mesmo nome: uma ficha por nome confirmado nesse contexto (índice único
 * parcial). O nome já confirmado noutra ficha não é gravado, e o conflito fica
 * auditado.
 *
 * O Vincular é a escolha do dono: o nome entra já confirmado
 * (`teachTipsterNamesFromChoice`), pelas mesmas travas de nome, e nunca toma o
 * nome confirmado de outra ficha.
 */

const log = createLogger("team-tipster-names");

/** A partir daqui o nome do tipster já casa com o da Pinnacle por regra (dicionário, abreviação). */
const SAME_NAME_EVIDENCE = 0.9;
const CONFLICT_ACTION = "team_tipster_name.conflict";
const METRIC = "team_tipster_name.learn";
/** A espera sai dois dias depois do jogo: o pareamento só liga jogo que ainda não começou. */
const WAIT_RETENTION_MS = 2 * 86_400_000;

type LearnOutcome =
  | "same_name"
  | "name_problem"
  | "other_side"
  | "no_card"
  | "category"
  | "pending"
  | "same_event"
  | "same_bet"
  | "same_day"
  | "ambiguous"
  | "confirmed"
  | "already_confirmed"
  | "conflict";

type Side = { tipsterName: string; pinnacleName: string; otherPinnacleName: string; flashscoreTeamId: string };

export type LearnTipsterTeamNamesInput = {
  betId: string;
  /** Id do evento na Pinnacle17 (o `match_id` da BridgeOdds é o mesmo). */
  pinnacleEventId: string;
  /** Os nomes do tipster, na orientação do evento casado. */
  tipster: { home: string; away: string };
  /** Os nomes da Pinnacle17 (ou da Bridge) do evento casado. */
  pinnacle: { home: string; away: string };
  /** Início do jogo casado: o dia de São Paulo que separa uma ocasião da outra. */
  kickoff: Date;
};

/**
 * Aprende os nomes do tipster dos dois lados do jogo casado. Sem ligação usável
 * do jogo, guarda a ocasião para a rodada do pareamento. Nunca lança: a
 * identidade já está gravada, e o aprendizado que falha só deixa de aprender.
 * Devolve se o jogo tinha ligação (e o aprendizado rodou).
 */
export async function learnTipsterTeamNames(input: LearnTipsterTeamNamesInput): Promise<boolean> {
  try {
    const link = await findUsableCatalogLink(input.pinnacleEventId);
    if (!link) {
      await waitForLink(input);
      await recordLearnMetric("no_link");
      return false;
    }
    const oriented = orientToLink(input, link);
    if (!oriented) {
      await recordLearnMetric("pinnacle_mismatch");
      return true;
    }
    const day = spDayKey(input.kickoff);
    const [homeTeamId, awayTeamId] = link.swapped
      ? [link.flashscoreAwayTeamId, link.flashscoreHomeTeamId]
      : [link.flashscoreHomeTeamId, link.flashscoreAwayTeamId];
    const sides: Side[] = [
      { tipsterName: oriented.tipster.home, pinnacleName: oriented.pinnacle.home, otherPinnacleName: oriented.pinnacle.away, flashscoreTeamId: homeTeamId },
      { tipsterName: oriented.tipster.away, pinnacleName: oriented.pinnacle.away, otherPinnacleName: oriented.pinnacle.home, flashscoreTeamId: awayTeamId },
    ];
    for (const side of sides) await recordLearnMetric(await learnSide(input, link, side, day));
    return true;
  } catch (error) {
    log.warn({ err: error, betId: input.betId, pinnacleEventId: input.pinnacleEventId }, "falha ao aprender o nome do tipster; identidade mantida");
    return false;
  }
}

/**
 * Os nomes do jogo casado na orientação da ligação. A Bridge devolve os nomes
 * da Pinnacle para o mesmo id, mas a orientação é conferida contra os nomes que
 * o pareamento gravou: invertidos, os dois pares invertem juntos; diferentes,
 * o jogo não é o da ligação e nada é aprendido.
 */
function orientToLink(
  input: Pick<LearnTipsterTeamNamesInput, "tipster" | "pinnacle">,
  link: UsableCatalogLink,
): Pick<LearnTipsterTeamNamesInput, "tipster" | "pinnacle"> | null {
  const orientation = linkOrientation(input.pinnacle, link);
  if (orientation === "same") return { tipster: input.tipster, pinnacle: input.pinnacle };
  if (orientation === "reversed") {
    return {
      tipster: { home: input.tipster.away, away: input.tipster.home },
      pinnacle: { home: input.pinnacle.away, away: input.pinnacle.home },
    };
  }
  return null;
}

function linkOrientation(pinnacle: { home: string; away: string }, link: UsableCatalogLink): "same" | "reversed" | null {
  const same = (a: string, b: string) => teamNameEvidence(a, b) >= SAME_NAME_EVIDENCE;
  if (same(pinnacle.home, link.pinnacleHome) && same(pinnacle.away, link.pinnacleAway)) return "same";
  if (same(pinnacle.home, link.pinnacleAway) && same(pinnacle.away, link.pinnacleHome)) return "reversed";
  return null;
}

/**
 * As travas do nome, antes de procurar a ficha: o nome que já casa com o da
 * Pinnacle por regra não tem o que ensinar, o que lembra o outro time do jogo
 * tanto quanto este (ou mais) não é deste lado, e o nome genérico só vale com
 * país e competição.
 */
function tipsterNameRefusal(
  side: Pick<Side, "tipsterName" | "pinnacleName" | "otherPinnacleName">,
  context: { country: string; competition: string },
): "same_name" | "other_side" | "name_problem" | null {
  const ownEvidence = teamNameEvidence(side.tipsterName, side.pinnacleName);
  if (ownEvidence >= SAME_NAME_EVIDENCE) return "same_name";
  // Sem semelhança com nenhum dos dois, vale a orientação da identidade.
  const otherEvidence = teamNameEvidence(side.tipsterName, side.otherPinnacleName);
  if (otherEvidence > 0 && otherEvidence >= ownEvidence) return "other_side";
  if (teamAliasNameProblem(side.tipsterName, {
    country: context.country,
    competition: context.competition,
    target: side.pinnacleName,
    author: "tipster",
  }) !== null) return "name_problem";
  return null;
}

async function learnSide(
  input: LearnTipsterTeamNamesInput,
  link: UsableCatalogLink,
  side: Side,
  day: string,
): Promise<LearnOutcome | null> {
  const nameNorm = canonicalizeTeamName(side.tipsterName);
  if (!nameNorm) return null;
  const refusal = tipsterNameRefusal(side, { country: link.pinnacleCountry, competition: link.pinnacleLeague });
  if (refusal) return refusal;

  // A ficha do lado, só se ele foi bem casado neste jogo (a evidência do evento).
  const card = await prisma.teamCard.findFirst({
    where: {
      sport: link.sport,
      flashscoreTeamId: side.flashscoreTeamId,
      evidence: { some: { pinnacleEventId: input.pinnacleEventId } },
    },
    select: {
      id: true,
      country: true,
      category: true,
      evidence: { where: { pinnacleEventId: input.pinnacleEventId }, select: { category: true } },
    },
  });
  if (!card) return "no_card";
  const category = teamCardCategory(side.tipsterName, link.pinnacleLeague);
  if (
    category !== card.category
    || card.evidence.some((row) => row.category !== card.category)
    || teamIdentityCategoryConflict(side.tipsterName, side.pinnacleName)
  ) return "category";

  try {
    return await prisma.$transaction(async (tx) => {
      // Outras fichas com o mesmo nome no mesmo contexto (esporte, país, categoria).
      const elsewhere = await tx.teamTipsterName.findMany({
        where: {
          sport: link.sport, country: card.country, category: card.category, nameNorm, cardId: { not: card.id },
        },
        select: { cardId: true, status: true },
      });
      const confirmedElsewhere = elsewhere.find((row) => row.status === "confirmed");
      if (confirmedElsewhere) {
        await tx.auditEvent.create({
          data: {
            action: CONFLICT_ACTION,
            resource: "team_card",
            resourceId: card.id,
            details: {
              betId: input.betId,
              pinnacleEventId: input.pinnacleEventId,
              name: side.tipsterName,
              nameNorm,
              confirmedCardId: confirmedElsewhere.cardId,
            },
          },
        });
        return "conflict";
      }
      const existing = await tx.teamTipsterName.findUnique({
        where: { cardId_nameNorm: { cardId: card.id, nameNorm } },
        select: { id: true, status: true, firstDay: true, firstBetId: true, firstPinnacleEventId: true },
      });
      if (!existing) {
        await tx.teamTipsterName.create({
          data: {
            cardId: card.id,
            sport: link.sport,
            country: card.country,
            category: card.category,
            name: side.tipsterName,
            nameNorm,
            firstBetId: input.betId,
            firstPinnacleEventId: input.pinnacleEventId,
            firstDay: day,
          },
        });
        return "pending";
      }
      if (existing.status === "confirmed") return "already_confirmed";
      if (existing.firstPinnacleEventId === input.pinnacleEventId) return "same_event";
      if (existing.firstBetId === input.betId) return "same_bet";
      if (existing.firstDay === day) return "same_day";
      // O mesmo nome pendente noutra ficha do contexto: nenhuma das duas confirma.
      if (elsewhere.length > 0) return "ambiguous";
      await tx.teamTipsterName.update({
        where: { id: existing.id },
        data: { status: "confirmed", confirmedAt: new Date(), confirmedByBetId: input.betId },
      });
      return "confirmed";
    });
  } catch (error) {
    // Outra aposta gravou o mesmo nome ao mesmo tempo (a mesma linha pendente,
    // ou o confirmado noutra ficha): a próxima ocasião decide.
    if ((error as { code?: unknown } | null)?.code === "P2002") return "conflict";
    throw error;
  }
}

// ───────────── Vincular: a escolha do dono ensina ─────────────

const CHOICE_ACTION = "team_tipster_name.choice";

export type ChosenGameTeachingResult =
  /** Gravado confirmado agora (nome novo ou o pendente da mesma ficha). */
  | "ensinado"
  | "ja_confirmado"
  /** O nome do tipster já casa com o da Pinnacle por regra: nada a ensinar. */
  | "mesmo_nome"
  | "outro_lado"
  | "nome_generico"
  | "categoria"
  | "sem_ficha"
  /** Sem a ligação do jogo, o nome da Pinnacle achou mais de uma ficha. */
  | "ficha_ambigua"
  /** A ligação do jogo tem outros nomes: não é o jogo escolhido. */
  | "ligacao_divergente"
  | "nome_de_outra_ficha";

export type ChosenGameTeaching = {
  lado: "casa" | "fora";
  nome: string;
  nomePinnacle: string;
  resultado: ChosenGameTeachingResult;
  cardId: string | null;
  /** O time da ficha, como o FlashScore o chama. */
  ficha: string | null;
  mensagem: string;
};

export type TeachFromChoiceInput = {
  betId: string;
  /** Id do evento na Pinnacle17 (o `match_id` da BridgeOdds é o mesmo). */
  pinnacleEventId: string;
  sport: string;
  /** Os nomes do tipster, na orientação do jogo escolhido. */
  tipster: { home: string; away: string };
  pinnacle: { home: string; away: string };
  /** Liga do candidato ("País - Competição"), o país e a competição dela. */
  league: string;
  country: string;
  competition: string;
  kickoff: Date | null;
  /** Quem vinculou: o operador da sessão ou o `agent:<nome>:por:<dono>`. */
  actor: string;
};

const CHOICE_MESSAGES: Record<ChosenGameTeachingResult, string> = {
  ensinado: "ensinado, já confirmado",
  ja_confirmado: "a ficha já tinha este nome",
  mesmo_nome: "é o nome da Pinnacle: nada a ensinar",
  outro_lado: "parece mais com o adversário: não ensinado",
  nome_generico: "nome genérico ou que não nomeia um time: não ensinado",
  categoria: "categoria diferente da ficha (reserva, feminino): não ensinado",
  sem_ficha: "sem ficha para ensinar",
  ficha_ambigua: "o nome da Pinnacle está em mais de uma ficha: não ensinado",
  ligacao_divergente: "o jogo ligado no pareamento tem outros nomes: não ensinado",
  nome_de_outra_ficha: "nome já é de outra ficha: não ensinado",
};

type ChoiceCard = { id: string; sport: string; country: string; category: string; flashscoreName: string };

/**
 * O nome do tipster que o Vincular ensina às fichas dos times do jogo
 * escolhido, já confirmado e com quem decidiu (`decidedBy`), no esporte da
 * ficha. A ficha vem da ligação do jogo no pareamento, orientada pelos ids e
 * só do lado bem casado naquele jogo; sem ligação, do nome da Pinnacle do
 * candidato (um jogo basta, porque a escolha já disse qual é o time), só com
 * uma ficha na categoria e no país e já vista na liga do candidato. Mesmas travas de nome do
 * aprendizado automático; o nome confirmado de outra ficha no mesmo contexto
 * não é tomado: o conflito fica auditado e vai no resultado.
 *
 * Com `apply: false` só diz o que faria (o plano do agente). Roda na
 * transação do Vincular: aposta vinculada e nome ensinado entram juntos.
 */
export async function teachTipsterNamesFromChoice(
  tx: Prisma.TransactionClient,
  input: TeachFromChoiceInput,
  options: { apply: boolean },
): Promise<ChosenGameTeaching[]> {
  const link = await findUsableCatalogLink(input.pinnacleEventId, tx);
  // Invertido: a casa do jogo escolhido é o visitante da ligação.
  const orientation = link ? linkOrientation(input.pinnacle, link) : null;
  const sides = [
    { lado: "casa" as const, tipsterName: input.tipster.home, pinnacleName: input.pinnacle.home, otherPinnacleName: input.pinnacle.away },
    { lado: "fora" as const, tipsterName: input.tipster.away, pinnacleName: input.pinnacle.away, otherPinnacleName: input.pinnacle.home },
  ];
  const results: ChosenGameTeaching[] = [];
  for (const side of sides) {
    const outcome = (resultado: ChosenGameTeachingResult, card: ChoiceCard | null = null): ChosenGameTeaching => ({
      lado: side.lado,
      nome: side.tipsterName,
      nomePinnacle: side.pinnacleName,
      resultado,
      cardId: card?.id ?? null,
      ficha: card?.flashscoreName ?? null,
      mensagem: CHOICE_MESSAGES[resultado],
    });
    const nameNorm = canonicalizeTeamName(side.tipsterName);
    if (!nameNorm) { results.push(outcome("nome_generico")); continue; }
    const refusal = tipsterNameRefusal(side, { country: input.country, competition: input.competition });
    if (refusal) {
      results.push(outcome(refusal === "same_name" ? "mesmo_nome" : refusal === "other_side" ? "outro_lado" : "nome_generico"));
      continue;
    }
    if (link && !orientation) { results.push(outcome("ligacao_divergente")); continue; }
    let card: ChoiceCard | null;
    if (link) {
      // O lado da Pinnacle17 na orientação da ligação leva ao id do FlashScore.
      const linkHome = orientation === "reversed" ? side.lado === "fora" : side.lado === "casa";
      const flashscoreTeamId = linkHome === link.swapped ? link.flashscoreAwayTeamId : link.flashscoreHomeTeamId;
      // Como no aprendizado automático: só o lado bem casado NESTE jogo (a
      // evidência do evento) tem ficha. Amistoso e lado fraco ficam sem ela.
      const linked = await tx.teamCard.findFirst({
        where: { sport: link.sport, flashscoreTeamId, evidence: { some: { pinnacleEventId: input.pinnacleEventId } } },
        select: {
          ...CHOICE_CARD_SELECT,
          evidence: { where: { pinnacleEventId: input.pinnacleEventId }, select: { category: true } },
        },
      });
      if (linked && linked.evidence.some((row) => row.category !== linked.category)) {
        results.push(outcome("categoria", linked));
        continue;
      }
      card = linked;
    } else {
      const found = await cardsByPinnacleName(tx, input, side.pinnacleName);
      if (found.length > 1) { results.push(outcome("ficha_ambigua")); continue; }
      card = found[0] ?? null;
    }
    if (!card) { results.push(outcome("sem_ficha")); continue; }
    if (
      teamCardCategory(side.tipsterName, input.league) !== card.category
      || teamIdentityCategoryConflict(side.tipsterName, side.pinnacleName)
    ) { results.push(outcome("categoria", card)); continue; }
    results.push(outcome(await writeChosenName(tx, input, card, side.tipsterName, nameNorm, options.apply), card));
  }
  return results;
}

const CHOICE_CARD_SELECT = { id: true, sport: true, country: true, category: true, flashscoreName: true } as const;

/**
 * Sem a ligação do jogo: as fichas em que o nome da Pinnacle já apareceu, na
 * categoria e no país do candidato. Um jogo basta, mas só na mesma liga do
 * candidato escolhido: a mesma grafia noutra liga pode ser outro time.
 */
async function cardsByPinnacleName(
  tx: Prisma.TransactionClient,
  input: TeachFromChoiceInput,
  pinnacleName: string,
): Promise<ChoiceCard[]> {
  const nameNorm = canonicalizeTeamName(pinnacleName);
  const league = normalizeStr(input.league);
  if (!nameNorm || !league) return [];
  const cards = await tx.teamCard.findMany({
    where: { sport: input.sport, evidence: { some: { nameNorm } } },
    select: { ...CHOICE_CARD_SELECT, evidence: { where: { leagueKey: { endsWith: `|${league}` } }, select: { id: true }, take: 1 } },
  });
  const category = teamCardCategory(pinnacleName, input.league);
  const fitting = cards.filter((card) => card.category === category
    && !hasTeamProviderCountryConflict({ expectedCountry: input.country, providerCountry: card.country }));
  // Duas fichas: ambígua, mesmo que só uma tenha a liga. Uma só: precisa da liga.
  if (fitting.length !== 1) return fitting;
  return fitting.filter((card) => card.evidence.length > 0);
}

async function writeChosenName(
  tx: Prisma.TransactionClient,
  input: TeachFromChoiceInput,
  card: ChoiceCard,
  name: string,
  nameNorm: string,
  apply: boolean,
): Promise<ChosenGameTeachingResult> {
  const scope = { sport: card.sport, country: card.country, category: card.category, nameNorm };
  const conflict = async (confirmedCardId: string | null) => {
    if (apply) {
      await tx.auditEvent.create({
        data: {
          actor: input.actor,
          action: CONFLICT_ACTION,
          resource: "team_card",
          resourceId: card.id,
          details: {
            betId: input.betId, pinnacleEventId: input.pinnacleEventId, name, nameNorm, confirmedCardId, via: "vincular",
          },
        },
      });
    }
    return "nome_de_outra_ficha" as const;
  };
  const confirmedElsewhere = await tx.teamTipsterName.findFirst({
    where: { ...scope, status: "confirmed", cardId: { not: card.id } },
    select: { cardId: true },
  });
  if (confirmedElsewhere) return conflict(confirmedElsewhere.cardId);
  const existing = await tx.teamTipsterName.findUnique({
    where: { cardId_nameNorm: { cardId: card.id, nameNorm } },
    select: { id: true, status: true },
  });
  if (existing?.status === "confirmed") return "ja_confirmado";
  if (!apply) return "ensinado";
  const confirmed = { status: "confirmed", confirmedAt: new Date(), confirmedByBetId: input.betId, decidedBy: input.actor };
  // O mesmo nome confirmado ao mesmo tempo noutra ficha (índice único): o
  // savepoint desfaz só a gravação do nome, e o vínculo da aposta fica.
  await tx.$executeRaw`SAVEPOINT teach_tipster_name`;
  try {
    if (existing) {
      await tx.teamTipsterName.update({ where: { id: existing.id }, data: confirmed });
    } else {
      await tx.teamTipsterName.create({
        data: {
          cardId: card.id,
          sport: card.sport,
          country: card.country,
          category: card.category,
          name,
          nameNorm,
          firstBetId: input.betId,
          firstPinnacleEventId: input.pinnacleEventId,
          firstDay: spDayKey(input.kickoff ?? new Date()),
          ...confirmed,
        },
      });
    }
    await tx.$executeRaw`RELEASE SAVEPOINT teach_tipster_name`;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== "P2002") throw error;
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT teach_tipster_name`;
    return conflict(null);
  }
  await tx.auditEvent.create({
    data: {
      actor: input.actor,
      action: CHOICE_ACTION,
      resource: "team_card",
      resourceId: card.id,
      details: { betId: input.betId, pinnacleEventId: input.pinnacleEventId, name, nameNorm, wasPending: Boolean(existing) },
    },
  });
  return "ensinado";
}

/** A ocasião guardada até a rodada do pareamento ligar o jogo. */
async function waitForLink(input: LearnTipsterTeamNamesInput): Promise<void> {
  const data = {
    pinnacleEventId: input.pinnacleEventId,
    tipsterHome: input.tipster.home,
    tipsterAway: input.tipster.away,
    pinnacleHome: input.pinnacle.home,
    pinnacleAway: input.pinnacle.away,
    kickoff: input.kickoff,
  };
  await runSerializableTransaction("teamNames.waitForLink", async (tx) => {
    // Serializa com a remoção: a tarefa atrasada não recria uma espera órfã.
    await tx.$queryRaw`SELECT id FROM bets WHERE id = ${input.betId} FOR UPDATE`;
    const bet = await tx.bet.findUnique({ where: { id: input.betId }, select: { deletedAt: true } });
    if (!bet || bet.deletedAt) return;
    await tx.teamTipsterNameWait.upsert({ where: { betId: input.betId }, create: { betId: input.betId, ...data }, update: data });
  });
}

/**
 * Os nomes que esperavam a ligação dos eventos que a rodada do pareamento
 * acabou de ligar, pelas mesmas regras. Só vale a aposta que ainda tem a
 * identidade casada automaticamente naquele evento; a que mudou de jogo ou foi
 * apagada perde a espera. Devolve quantas apostas aprenderam.
 */
export async function learnWaitingTipsterNames(pinnacleEventIds: readonly string[]): Promise<number> {
  if (pinnacleEventIds.length === 0) return 0;
  const waits = await prisma.teamTipsterNameWait.findMany({ where: { pinnacleEventId: { in: [...new Set(pinnacleEventIds)] } } });
  let learned = 0;
  for (const wait of waits) {
    const bet = await prisma.bet.findUnique({
      where: { id: wait.betId },
      select: { deletedAt: true, sharp: { select: { identityStatus: true, provider: true, providerMatchId: true } } },
    });
    const stillAutomatic = bet && !bet.deletedAt && bet.sharp?.identityStatus === "MATCHED"
      && (bet.sharp.provider === "pinnacle17" || bet.sharp.provider === "bridgeodds")
      && bet.sharp.providerMatchId === wait.pinnacleEventId;
    const ran = stillAutomatic && await learnTipsterTeamNames({
      betId: wait.betId,
      pinnacleEventId: wait.pinnacleEventId,
      tipster: { home: wait.tipsterHome, away: wait.tipsterAway },
      pinnacle: { home: wait.pinnacleHome, away: wait.pinnacleAway },
      kickoff: wait.kickoff,
    });
    if (ran) learned += 1;
    // Sem ligação usável ainda (o dobro, por exemplo), a espera fica.
    if (ran || !stillAutomatic) await prisma.teamTipsterNameWait.deleteMany({ where: { id: wait.id } });
  }
  return learned;
}

/** Retenção: a espera sai dois dias depois do jogo. */
export async function purgeExpiredTipsterNameWaits(now = new Date()): Promise<number> {
  const result = await prisma.teamTipsterNameWait.deleteMany({
    where: { kickoff: { lt: new Date(now.getTime() - WAIT_RETENTION_MS) } },
  });
  return result.count;
}

async function recordLearnMetric(result: LearnOutcome | "no_link" | "pinnacle_mismatch" | null): Promise<void> {
  if (!result) return;
  await recordOperationalMetric({ kind: "action", name: METRIC, outcome: "success", labels: { result } });
}
