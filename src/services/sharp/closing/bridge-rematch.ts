import { sameKickoff } from "@/src/domain/kickoff-infer";
import { BudgetExhaustedError } from "@/src/domain/provider-error";
import { bestSearchWord, splitEventoTeams } from "@/src/domain/text";
import { getEnv } from "@/src/infra/env";
import { createLogger } from "@/src/infra/logger";
import {
  BridgeAnswerCappedError,
  findBridgeMatch,
  findBridgeMatchByIdWithEvidence,
} from "@/src/providers/bridgeodds/match";
import type { BridgeQueryFn } from "@/src/providers/bridgeodds/scoring";
import {
  writeBridgeMatchSnapshot,
  type BridgeObservedMatch,
} from "@/src/providers/bridgeodds/snapshot-cache";
import { bridgeSportFromEsporte } from "@/src/providers/bridgeodds/coverage-contract";
import { applyTeamAliases } from "@/src/services/sharp/enrich/identity-cache";

const log = createLogger("bridge-postgame");

/**
 * O jogo da aposta na BridgeOdds depois do jogo, com a resposta observada: pelo
 * id quando já casada ali; senão pela busca, acima do limiar AUTO. A busca
 * pós-jogo (`bridge-postgame.ts`) lê dela a abertura e o fechamento.
 *
 * A BridgeOdds repassa o feed da Pinnacle com o mesmo id de evento da
 * Pinnacle17. Aposta casada pela Pinnacle17 é achada pelo id, na consulta
 * completa (dias vizinhos e sem o filtro do mandante, porque o nome da
 * Pinnacle17 nem sempre é a palavra que a Bridge filtra), e só vale com o
 * mesmo kickoff: a busca por nome escolheria o primeiro candidato acima do
 * limiar, sem juiz nem desempate.
 *
 * Null só com a resposta completa da Bridge. Sem ela, lança: a cota ou o prazo
 * acabando no meio da busca (`BudgetExhaustedError`) param a busca pós-jogo, e
 * o teto de páginas (`BridgeAnswerCappedError`) só pula esta aposta. Nenhum dos
 * dois gasta a tentativa dela.
 */
export async function resolveBridgePostgameMatch(
  bet: {
    id: string;
    evento: string;
    esporte: string;
    data: Date;
    pais: string;
    competicao: string;
    sharp: { provider: string | null; providerMatchId: string | null } | null;
  },
  deps: { now?: Date; query?: BridgeQueryFn },
): Promise<BridgeObservedMatch | null> {
  const teams = splitEventoTeams(bet.evento);
  const bridgeSport = bridgeSportFromEsporte(bet.esporte);
  if (!teams || !bridgeSport) return null;

  const aliased = await applyTeamAliases(teams, bet.esporte, bet.pais, bet.competicao);
  const pinnacle17Id = bet.sharp?.provider === "pinnacle17" && /^\d+$/.test(bet.sharp.providerMatchId ?? "")
    ? bet.sharp.providerMatchId
    : null;
  if (pinnacle17Id) {
    const observed = await findBridgeMatchByIdWithEvidence({
      providerMatchId: pinnacle17Id,
      searchWord: bestSearchWord(aliased.home),
      bridgeSport,
      kickoffUtc: bet.data,
      ...(deps.query ? { query: deps.query } : {}),
      mode: "full",
      purpose: "closing",
      now: deps.now,
      requireComplete: true,
    });
    if (observed && sameKickoff(new Date(observed.match.match_date), bet.data)) return observed;
    log.info(
      { betId: bet.id, providerMatchId: pinnacle17Id, found: Boolean(observed) },
      "busca pós-jogo: id da Pinnacle17 sem jogo no mesmo horário na Bridge — sem busca por nome",
    );
    return null;
  }
  const providerMatchId = bet.sharp?.provider === "bridgeodds"
    ? bet.sharp.providerMatchId
    : null;

  if (providerMatchId) {
    const observed = await findBridgeMatchByIdWithEvidence({
      providerMatchId,
      searchWord: bestSearchWord(aliased.home),
      bridgeSport,
      kickoffUtc: bet.data,
      ...(deps.query ? { query: deps.query } : {}),
      purpose: "closing",
      now: deps.now,
      requireComplete: true,
    });
    if (observed) return observed;
    // ID conhecido não abre fan-out caro; o próximo ciclo tenta novamente.
    log.info(
      { betId: bet.id, providerMatchId },
      "busca pós-jogo: id da Bridge sem resposta — sem fan-out findBridgeMatch",
    );
    return null;
  }

  const found = await findBridgeMatch({
    home: aliased.home,
    away: aliased.away,
    bridgeSport,
    kickoffUtc: bet.data,
    competition: bet.competicao,
    ...(deps.query ? { query: deps.query } : {}),
  });
  if (!found.ok) {
    if (found.reason === "search_budget" || (found.reason === "truncated" && found.incomplete)) {
      throw new BudgetExhaustedError("bridgeodds", "bridge-lookup-incomplete");
    }
    if (found.reason === "truncated") throw new BridgeAnswerCappedError();
    return null;
  }

  const minScore = getEnv().SHARP_AUTO_MATCH_MIN_SCORE;
  if (found.best.score < minScore) {
    log.info(
      { betId: bet.id, score: found.best.score, minScore },
      "busca pós-jogo: match abaixo do limiar AUTO — skip",
    );
    return null;
  }
  if (found.stalePrices) {
    return findBridgeMatchByIdWithEvidence({
      providerMatchId: String(found.best.match.match_id),
      searchWord: bestSearchWord(found.best.match.home),
      bridgeSport,
      kickoffUtc: bet.data,
      ...(deps.query ? { query: deps.query } : {}),
      mode: "cheap",
      purpose: "closing",
      now: deps.now,
      requireComplete: true,
    });
  }
  const observedAt = found.priceObservedAt;
  if (!deps.query) {
    return writeBridgeMatchSnapshot({
      match: found.best.match,
      purpose: "closing",
      observedAt,
    });
  }
  return { match: found.best.match, observedAt };
}
