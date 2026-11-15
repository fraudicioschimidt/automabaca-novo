import type { BetStatus } from "@/src/domain/bet-status";
import { isMethodOfVictoryMarket, isOutrightMarket, isRaceToMarket, isThreeWayHandicapMarket, marketIncludesExtraTime, marketKindOf, marketPeriodOf } from "@/src/domain/mercados/classify";
import { keepDeclaredPeriod } from "@/src/domain/mercados/finalize";
import { hasNonScoreStatQualifier, hasScoreUnitMismatch, hasUnknownScoreQualifier } from "@/src/domain/mercados/stat-qualifier";
import { inferPinnacleStatMarket } from "@/src/domain/mercados/stat-unit";
import { selecaoNomeiaTimeDoTotal, selecaoPareceTotal } from "@/src/domain/mercados/selection-shape";
import { normalizeStr, splitEventoTeams } from "@/src/domain/text";

/** Uma perna liquidável: um jogo × um mercado × uma seleção. */
export type BetLeg = {
  evento: string;
  mercado: string;
  selecao: string;
};

export type BetLegsKind = "same_game" | "parlay";

export type BetLegsTicket = {
  kind: BetLegsKind;
  legs: BetLeg[];
};

const CONFRONTATION = /\s+(?:vs\.?|x)\s+/i;
const FIXTURE_SPLITS = [/\s*\/\s+/, /\s*\|\s*/];
const SELECTION_SPLIT = /\s+(?:\/|\+)\s+/;
const ML_TOKEN = /\b(?:ml|moneyline)\b/i;

export function isMultiFixtureTicket(ticket: BetLegsTicket): boolean {
  const eventos = new Set(ticket.legs.map((leg) => normalizeStr(leg.evento)));
  return ticket.kind === "parlay" || eventos.size > 1;
}

export function parseStoredLegs(raw: unknown): BetLegsTicket | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { kind?: unknown; legs?: unknown };
  if (value.kind !== "same_game" && value.kind !== "parlay") return null;
  if (!Array.isArray(value.legs) || value.legs.length < 2 || value.legs.length > 8) {
    return null;
  }
  const legs: BetLeg[] = [];
  for (const item of value.legs) {
    if (!item || typeof item !== "object") return null;
    const leg = item as { evento?: unknown; mercado?: unknown; selecao?: unknown };
    if (typeof leg.evento !== "string" || typeof leg.mercado !== "string" || typeof leg.selecao !== "string") {
      return null;
    }
    const evento = leg.evento.trim();
    const mercado = leg.mercado.trim();
    const selecao = leg.selecao.trim();
    if (!evento || !mercado || !selecao) return null;
    if (!splitEventoTeams(evento)) return null;
    legs.push({ evento, mercado, selecao });
  }
  return { kind: value.kind, legs };
}

/** Compara termos normalizados; ordem das pernas e das chaves JSON é cosmética. */
export function sameBetLegs(before: unknown, after: unknown): boolean {
  if (before == null || after == null) return before == null && after == null;
  const a = parseStoredLegs(before);
  const b = parseStoredLegs(after);
  // Estrutura inválida não prova equivalência de termos financeiros.
  if (!a || !b || a.kind !== b.kind) return false;
  const terms = (ticket: BetLegsTicket) => ticket.legs.map((leg) =>
    JSON.stringify([leg.evento, leg.mercado, leg.selecao].map(normalizeStr)),
  ).sort();
  return JSON.stringify(terms(a)) === JSON.stringify(terms(b));
}

/**
 * Detecta dupla/tripla/SGP no texto cru de Jogo + Entrada (Target e afins).
 * Null = ticket simples. Não parte `Flamengo / Palmeiras` (um confronto).
 *
 * O período que o mercado do bilhete declara ("1º Tempo" + "Over 0.5 +
 * Flamengo") vale para a perna que não declara o próprio: sem ele, a perna
 * seria liquidada pelo placar final.
 */
export function parseBetLegs(evento: string, selecao: string, mercado = ""): BetLegsTicket | null {
  const withTicketContext = (leg: BetLeg): BetLeg => {
    const sourceKind = marketKindOf(mercado);
    const legKind = marketKindOf(leg.mercado);
    // Inferir a família pelo pick não apaga unidade ou mecânica escritas só
    // no bilhete. Sem prova por perna, preserva o rótulo para a recusa normal.
    const protectedMarket = hasNonScoreStatQualifier(mercado, "") || hasUnknownScoreQualifier(mercado)
      || hasScoreUnitMismatch(mercado, "") || isThreeWayHandicapMarket(mercado)
      || isMethodOfVictoryMarket(mercado) || isOutrightMarket(mercado) || isRaceToMarket(mercado)
      || (sourceKind === legKind && sourceKind !== "other" && marketPeriodOf(mercado) === "FT")
      || (legKind === "total" && sourceKind === "team_total")
      || (legKind === "moneyline" && ["draw_no_bet", "double_chance"].includes(sourceKind));
    let legMarket = protectedMarket ? mercado : leg.mercado;
    if (marketIncludesExtraTime(mercado) && !marketIncludesExtraTime(legMarket)) {
      legMarket = `${legMarket} incluindo prorrogação`;
    }
    return { ...leg, mercado: marketPeriodOf(leg.selecao) === "FT" ? keepDeclaredPeriod(mercado, legMarket) : legMarket };
  };
  const fixtures = splitFixtureList(evento);
  const picks = splitSelectionLegs(selecao);
  if (fixtures && picks && fixtures.length === picks.length) {
    return {
      kind: "parlay",
      legs: fixtures.map((fixture, index) => withTicketContext(toLeg(fixture, picks[index] ?? ""))),
    };
  }
  if (fixtures && picks && fixtures.length !== picks.length) return null;
  if (!fixtures && picks && splitEventoTeams(evento)) {
    const fixture = canonicalFixture(evento);
    if (!fixture) return null;
    if (!picks.every((pick) => selectionBelongsToFixture(pick, fixture))) return null;
    return {
      kind: "same_game",
      legs: picks.map((pick) => withTicketContext(toLeg(fixture, pick))),
    };
  }
  return null;
}

export function foldLegStatuses(statuses: BetStatus[]):
  | { ok: true; status: BetStatus }
  | { ok: false; reason: "incomplete" | "needs_review" } {
  if (statuses.length === 0) return { ok: false, reason: "incomplete" };
  if (statuses.some((status) => status === "LOST")) {
    return { ok: true, status: "LOST" };
  }
  if (statuses.every((status) => status === "WON")) {
    return { ok: true, status: "WON" };
  }
  return { ok: false, reason: "needs_review" };
}

function splitFixtureList(evento: string): string[] | null {
  for (const delim of FIXTURE_SPLITS) {
    const fixtures = splitFixturesOn(evento, delim);
    if (fixtures) return fixtures;
  }
  return null;
}

function splitFixturesOn(evento: string, delim: RegExp): string[] | null {
  const parts = evento.split(delim).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const fixtures: string[] = [];
  for (const part of parts) {
    if (!CONFRONTATION.test(part)) return null;
    const fixture = canonicalFixture(part);
    if (!fixture) return null;
    fixtures.push(fixture);
  }
  return fixtures;
}

function splitSelectionLegs(selecao: string): string[] | null {
  const parts = selecao.split(SELECTION_SPLIT).map((part) => part.trim()).filter(Boolean);
  return parts.length >= 2 ? parts : null;
}

function canonicalFixture(raw: string): string | null {
  const teams = splitEventoTeams(raw);
  if (!teams || !/\p{L}/u.test(teams.home) || !/\p{L}/u.test(teams.away)) return null;
  return `${teams.home} vs ${teams.away}`;
}

function selectionBelongsToFixture(selecao: string, evento: string): boolean {
  const teams = splitEventoTeams(evento);
  if (!teams) return false;
  const blob = normalizeStr(selecao);
  return normalizeStr(teams.home).split(" ").some((token) => token.length > 2 && blob.includes(token))
    || normalizeStr(teams.away).split(" ").some((token) => token.length > 2 && blob.includes(token))
    || selecaoPareceTotal(selecao)
    || ML_TOKEN.test(selecao);
}

function toLeg(evento: string, selecaoRaw: string): BetLeg {
  const selecao = selecaoRaw.trim();
  if (selecaoPareceTotal(selecao) || /(?:^|\s)(?:o|ov|u|un)\s*\.?\s*\d/i.test(selecao)) {
    return {
      evento,
      // O time nomeado ("Mogi O89,5") faz do total o total DO TIME, como na
      // captura: com o rótulo de total do jogo a perna ficaria sem resposta.
      mercado: inferPinnacleStatMarket(
        selecaoNomeiaTimeDoTotal(selecao, evento) ? "Team Total" : "Total", selecao, "", evento,
      ),
      selecao,
    };
  }
  if (/[+-]\d+(?:[.,]\d+)?/.test(normalizeStr(selecao))) {
    return {
      evento,
      mercado: inferPinnacleStatMarket("Asian Handicap", selecao),
      selecao,
    };
  }
  return {
    evento,
    mercado: "Moneyline",
    // Só tira o marcador ML. HT/H5/FT ficam na seleção para o liquidador
    // recusar período — apagar aqui fazia "ML HT FT" virar moneyline de 40 min.
    selecao: ML_TOKEN.test(selecao)
      ? selecao.replace(/\b(?:ml|moneyline)\b/gi, " ").replace(/\s+/g, " ").trim() || selecao
      : selecao,
  };
}
