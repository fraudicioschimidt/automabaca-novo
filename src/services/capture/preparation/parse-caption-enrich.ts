import type { ParsedBetPost } from "@/src/domain/bet-capture";
import { bookmakerFromBetLinks } from "@/src/domain/bookmaker-bet-link";
import { inferPinnacleStatMarket } from "@/src/domain/mercados/stat-unit";
import { detectSportFromText, llmReadSport, UNKNOWN_SPORT, unresolvedSportDecision } from "@/src/domain/sports/detect";
import { normalizeStr } from "@/src/domain/text";
import {
  canonicalCompetition,
  canonicalCountry,
} from "@/src/domain/national-teams";

/**
 * Enriquece o parse com sinais da legenda tipster (mercado asiático de stats,
 * esporte, casa, competição/país omitidos pelo LLM). Puro — sem I/O. Odd e
 * stake da legenda ficam com o guard, que as confere contra a política da banca.
 */

/** O Caribe não é um país: a CPL fica sem país. */
const REGIONAL_PREMIER_LEAGUE_COUNTRY: Partial<Record<string, string>> = { indian: "India", bangladesh: "Bangladesh", lanka: "Sri Lanka" };

export function inferPaisFromCompeticao(competicao: string): string {
  const c = competicao.trim();
  if (!c) return "";
  const lower = normalizeStr(c);
  if (/fifa|world cup|cwc|club world cup|mundial|concacaf|conmebol|copa america|gold cup|libertadores|sul-americana/.test(lower)) {
    return "International";
  }
  if (/euro|uefa|nations league|champions league|europa league|conference league/.test(lower)) {
    return "International";
  }
  if (
    /brasileir|brazil|paulista|carioca|baiano|mineiro|gaucho|copa do brasil/.test(
      lower,
    )
  ) {
    return "Brazil";
  }
  if (/italy|italia|italian|coppa italia/.test(lower) || /^serie [ab] italy$/.test(lower)) return "Italy";
  // As "X Premier League" do críquete, e a do futebol de Bangladesh, não são da Inglaterra.
  const regional = lower.match(/\b(indian|bangladesh|lanka|caribbean) premier league\b/)?.[1];
  if (regional) return REGIONAL_PREMIER_LEAGUE_COUNTRY[regional] ?? "";
  if (/premier league|championship|fa cup|efl|league (?:one|two)/.test(lower)) return "England";
  if (/la liga|copa del rey|segunda division/.test(lower)) return "Spain";
  if (/bundesliga|dfb/.test(lower)) return /austria|austrian/.test(lower) ? "Austria" : "Germany";
  if (/ligue [12]|coupe de france/.test(lower)) return "France";
  if (/mls|major league soccer|usl/.test(lower)) return "USA";
  if (/eredivisie|eerste divisie/.test(lower)) return "Netherlands";
  if (/liga portugal|primeira liga/.test(lower)) return "Portugal";
  if (/super lig/.test(lower)) return "Turkey";
  if (/j[12]?[ -]?league/.test(lower)) return "Japan";
  if (/a[ -]?league/.test(lower)) return "Australia";
  if (/liga mx/.test(lower)) return "Mexico";
  if (/argentin|primera nacional/.test(lower)) return "Argentina";
  if (/saudi pro league/.test(lower)) return "Saudi Arabia";
  return "";
}

export function inferCompeticaoFromSlipText(text: string): string {
  const lower = text.toLowerCase();
  if (/copa do mundo|world cup|fifa\s*[-–]?\s*world|mundial\s*fifa/i.test(lower)) {
    return "FIFA World Cup";
  }
  if (/club world cup|cwc|mundial de clubes/i.test(lower)) {
    return "FIFA Club World Cup";
  }
  if (/copa america|gold cup|concacaf/i.test(lower)) return "CONCACAF / Copa America";
  if (/euro\s*20|uefa euro|eurocopa/i.test(lower)) return "UEFA Euro";
  if (/nations league/i.test(lower)) return "UEFA Nations League";
  return "";
}

/** Preenche lacunas e corrige mercado/esporte óbvios a partir da legenda. */
export function enrichParsedBetFromCaption(
  bet: ParsedBetPost,
  caption: string,
): ParsedBetPost {
  const blob = `${caption}\n${bet.evento}\n${bet.mercado}\n${bet.selecao}`;

  let competicao = canonicalCompetition(bet.competicao.trim());
  if (!competicao) competicao = inferCompeticaoFromSlipText(blob);
  else competicao = canonicalCompetition(competicao);

  let pais = canonicalCountry(bet.pais.trim());
  if (!pais && competicao) pais = inferPaisFromCompeticao(competicao);
  else if (pais) pais = canonicalCountry(pais);

  const mercado = inferPinnacleStatMarket(
    bet.mercado,
    bet.selecao,
    caption,
    bet.evento,
    bet.esporte,
  );

  const captionSport = detectSportFromText(blob, { itemSport: llmReadSport(bet.sportResolution) });
  let sportResolution = bet.sportResolution ?? unresolvedSportDecision();
  if (captionSport.status === "CONFIRMED") {
    if (
      sportResolution.status === "CONFIRMED" &&
      sportResolution.sport !== captionSport.sport
    ) {
      sportResolution = unresolvedSportDecision("CONFLICT", [
        ...sportResolution.evidence,
        ...captionSport.evidence,
      ]);
    } else {
      // A leitura da IA fica na evidência: a decisão da captura, com a
      // competição do item, ainda a consulta (`llmReadSport`).
      sportResolution = {
        ...captionSport,
        evidence: [...captionSport.evidence, ...sportResolution.evidence.filter((item) => item.source === "LLM")],
      };
    }
  } else if (captionSport.status === "CONFLICT") {
    sportResolution = unresolvedSportDecision("CONFLICT", [
      ...sportResolution.evidence,
      ...captionSport.evidence,
    ]);
  }
  const esporte = sportResolution.sport ?? UNKNOWN_SPORT;

  return {
    ...bet,
    casaDeAposta: bet.casaDeAposta.trim() || bookmakerFromBetLinks(caption) || "",
    competicao,
    pais,
    mercado,
    esporte,
    sportResolution,
  };
}
