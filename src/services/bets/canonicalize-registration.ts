import { canonicalizeTeamName, normalizeStr, splitEventoTeams } from "@/src/domain/text";
import {
  canonicalCompetition,
  canonicalCountry,
  rewriteSelecaoWithMatchedTeams,
  translateNationalTeamPtToEn,
} from "@/src/domain/national-teams";
import {
  stripDrawNoBetFromSelection,
} from "@/src/domain/mercados/draw-vocabulary";
import { canonicalDoubleChanceSelection } from "@/src/domain/mercados/double-chance-selection";
import { pinnacleizeSelecao } from "@/src/domain/mercados/selecao";
import { isDrawNoBetMarket, marketIncludesExtraTime, marketKindOf, marketPeriodOf } from "@/src/domain/mercados/classify";
import { restrictsToRegulationTime } from "@/src/domain/mercados/compatibility";
import { finalizePinnacleMarket } from "@/src/domain/mercados/finalize";
import { sharpEquivalentBet } from "@/src/domain/mercados/sharp-equivalent";
import { hasNonScoreStatQualifier, hasScoreUnitMismatch } from "@/src/domain/mercados/stat-qualifier";

export type CanonicalizableBetRegistration = {
  evento: string;
  esporte: string;
  competicao: string;
  pais: string;
  mercado: string;
  selecao: string;
};

/**
 * Seleção nacional em português com o nome da Pinnacle. Só no futebol: o
 * mapa veio dos feeds de futebol, e "Franca" no basquete é o clube.
 */
function nationalTeamName(name: string, sport: string): string {
  if (normalizeStr(sport) !== "soccer") return name;
  const nation = translateNationalTeamPtToEn(name);
  return nation && canonicalizeTeamName(nation) !== canonicalizeTeamName(name) ? nation : name;
}

/**
 * Os nomes dos times que o registro grava: os do tipster. Troca só a seleção
 * nacional escrita em português. A ficha do time não troca nome aqui: uma
 * tradução errada gravaria o jogo de outro time, com a seleção junto, e o nome
 * do post sumiria com a evidência da captura (e com ele o nome que o tipster
 * ensina à ficha). O nome canônico chega no casamento com o fornecedor, que
 * renomeia o evento e a seleção juntos.
 */
function registeredTeamNames(
  teams: { home: string; away: string },
  bet: CanonicalizableBetRegistration,
): { home: string; away: string } {
  const home = nationalTeamName(teams.home, bet.esporte);
  const away = nationalTeamName(teams.away, bet.esporte);
  // Os dois lados no mesmo nome não é este jogo: fica o que o tipster escreveu.
  return canonicalizeTeamName(home) === canonicalizeTeamName(away) ? teams : { home, away };
}

/**
 * Canonização independente da origem, executada antes de qualquer persistência.
 * OCR/retries continuam no adaptador de captura; país, competição, vocabulário
 * DNB/DC e nomes dos times pertencem ao contrato único do registro.
 */
export async function canonicalizeBetForRegistration<
  T extends CanonicalizableBetRegistration,
>(rawBet: T): Promise<T> {
  let bet = {
    ...rawBet,
    pais: canonicalCountry(rawBet.pais),
    competicao: canonicalCompetition(rawBet.competicao),
  } as T;

  let doubleChance: ReturnType<typeof canonicalDoubleChanceSelection> = null;
  const dnbSelection = stripDrawNoBetFromSelection(bet.selecao);
  const isDnb = dnbSelection.isDnb || isDrawNoBetMarket(bet.mercado);
  if (isDnb) {
    const cleanTeam = dnbSelection.isDnb ? dnbSelection.cleanTeam : bet.selecao;
    const kind = marketKindOf(bet.mercado, bet.selecao, bet.evento);
    const equivalent = ["moneyline", "draw_no_bet"].includes(kind) &&
      // A conversão do registro não pode apagar regras do rótulo original.
      ![bet.mercado, bet.selecao].some(text => marketIncludesExtraTime(text) ||
        restrictsToRegulationTime(text, bet.esporte)) &&
      marketPeriodOf(bet.mercado, bet.esporte) === "FT" &&
      !hasNonScoreStatQualifier(bet.mercado, bet.selecao) &&
      !hasScoreUnitMismatch(bet.mercado, bet.selecao, bet.esporte) &&
      !/(?:^|\s)[+−–-]\s*\d/.test(cleanTeam)
      ? sharpEquivalentBet({ ...bet, mercado: "Draw No Bet", selecao: cleanTeam }) : null;
    if (equivalent) bet = {
      ...bet,
      mercado: finalizePinnacleMarket(equivalent.mercado, bet.esporte),
      selecao: equivalent.selecao.replace(/ 0\.0$/, " 0"),
    };
  } else {
    doubleChance = canonicalDoubleChanceSelection(bet);
    if (doubleChance) bet = { ...bet, ...doubleChance };
  }

  const teams = splitEventoTeams(bet.evento);
  if (!teams) return bet;

  const names = registeredTeamNames(teams, bet);
  const evento = names.home !== teams.home || names.away !== teams.away
    ? `${names.home} vs ${names.away}`
    : bet.evento;
  const selecao = doubleChance ? pinnacleizeSelecao({
    selecao: bet.selecao,
    mercadoPinnacle: bet.mercado,
    evento,
    esporte: bet.esporte,
  }) : rewriteSelecaoWithMatchedTeams({
    selecao: bet.selecao,
    localHome: teams.home,
    localAway: teams.away,
    pinnacleHome: names.home,
    pinnacleAway: names.away,
  });

  return { ...bet, evento, selecao };
}
