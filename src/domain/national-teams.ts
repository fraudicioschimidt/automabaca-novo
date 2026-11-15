import { canonicalizeTeamName, normalizeStr } from "@/src/domain/text";
import {
  CANONICAL_COUNTRY_MAP,
  COMPETITION_PT_EN,
  KNOWN_COUNTRY_KEYS,
  NATIONAL_TEAMS_PT_EN,
} from "./countries";

export {
  CANONICAL_COUNTRY_MAP,
  COMPETITION_PT_EN,
  KNOWN_COUNTRY_KEYS,
  NATIONAL_TEAMS_PT_EN,
};

/** Traduz seleção nacional ou país PT → EN Pinnacle; null se não for nação conhecida. */
export function translateNationalTeamPtToEn(localName: string): string | null {
  const key = canonicalizeTeamName(localName);
  if (!key) return null;
  return NATIONAL_TEAMS_PT_EN[key] ?? null;
}

/** Normaliza país para o padrão Pinnacle/EN ("Brasil" -> "Brazil", "Alemanha" -> "Germany", etc.) */
export function canonicalCountry(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const norm = canonicalizeTeamName(trimmed);
  if (CANONICAL_COUNTRY_MAP[norm]) {
    return CANONICAL_COUNTRY_MAP[norm];
  }
  const direct = translateNationalTeamPtToEn(trimmed);
  if (direct) return direct;
  return trimmed
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** Normaliza competições para o padrão oficial Pinnacle/EN, sem duplicação de país. */
export function canonicalCompetition(raw: string, pais?: string): string {
  let trimmed = raw.trim();
  if (!trimmed) return "";

  // 1. Mapeamento direto por nome conhecido PT -> EN
  const lower = normalizeStr(trimmed);
  if (COMPETITION_PT_EN[lower]) {
    return COMPETITION_PT_EN[lower];
  }

  // 2. Formato bruto do Flashscore "PAIS: Competição [ - Fase]"
  const flashscoreMatch = trimmed.match(/^([\p{L}\p{M}\s]+):\s*(.+)$/u);
  if (flashscoreMatch) {
    const rawTourn = (flashscoreMatch[2] ?? "")
      .replace(
        /\s*-\s*(?:Losers stage|Apertura|Clausura|Preliminary|Play Offs|5th-8th places|\d+(?:st|nd|rd|th)[^)]*)$/i,
        "",
      )
      .trim();

    const tournLower = normalizeStr(rawTourn);
    if (COMPETITION_PT_EN[tournLower]) {
      return COMPETITION_PT_EN[tournLower];
    }
    trimmed = rawTourn;
  }

  // 3. Remove prefixo redundante "Pais - Competicao" quando o país já está no campo país
  if (pais) {
    const cPais = canonicalCountry(pais);
    const prefixRegex = new RegExp(`^${escapeRegExp(cPais)}\\s*-\\s*`, "i");
    if (prefixRegex.test(trimmed)) {
      trimmed = trimmed.replace(prefixRegex, "").trim();
    }
  } else {
    // Se tiver "NomeDoPais - Competicao" e o prefixo for um país canônico conhecido
    const dashIdx = trimmed.indexOf(" - ");
    if (dashIdx > 0) {
      const possibleCountry = trimmed.slice(0, dashIdx).trim();
      const possibleTourn = trimmed.slice(dashIdx + 3).trim();
      if (KNOWN_COUNTRY_KEYS.has(normalizeStr(possibleCountry))) {
        trimmed = possibleTourn;
      }
    }
  }

  const cleanLower = normalizeStr(trimmed);
  if (COMPETITION_PT_EN[cleanLower]) {
    return COMPETITION_PT_EN[cleanLower];
  }

  return trimmed;
}

/**
 * Substitui nomes de nação PT pelo EN Pinnacle dentro de um texto (seleção).
 * Com os times do jogo, só a nação que é um deles: "Franca", clube de
 * basquete, não vira France, nem "Brasil de Pelotas" vira Brazil.
 */
export function rewriteNationalTeamsInText(text: string, eventTeams?: readonly string[]): string {
  const teams = eventTeams?.map(canonicalizeTeamName);
  let out = text;
  const entries = Object.entries(NATIONAL_TEAMS_PT_EN).sort((a, b) => b[0].length - a[0].length);
  for (const [ptKey, en] of entries) {
    if (teams && !teams.includes(canonicalizeTeamName(en))) continue;
    const wordCount = ptKey.split(" ").length;
    const wordPat = Array.from({ length: wordCount }, () => "[\\p{L}']+").join("\\s+");
    out = out.replace(new RegExp(`(?<!\\p{L})${wordPat}(?!\\p{L})`, "giu"), (match) =>
      canonicalizeTeamName(match) === ptKey ? en : match,
    );
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Quando a identidade casa, o evento vira "France vs Morocco" mas a seleção
 * ainda pode estar "França -1.0". Sem reescrever, matchTeamSide falha
 * (similaridade PT↔EN ~0.2) e a odd cai em ambiguous_selection.
 */
export function rewriteSelecaoWithMatchedTeams(params: {
  selecao: string;
  localHome: string;
  localAway: string;
  pinnacleHome: string;
  pinnacleAway: string;
}): string {
  let out = params.selecao;
  const candidatePairs: Array<[string, string]> = [
    [params.localHome, params.pinnacleHome],
    [params.localAway, params.pinnacleAway],
  ];
  const pairs = candidatePairs
    .filter(([local, pinn]) => local && pinn && canonicalizeTeamName(local) !== canonicalizeTeamName(pinn))
    .sort((a, b) => b[0].length - a[0].length);

  for (const [local, pinn] of pairs) {
    // A dupla chance "12" é "Casa or Fora": o nome seguido do outro time do
    // jogo, com o nome local ou o já trocado, também é o time.
    const otherTeam = (local === params.localHome ? [params.localAway, params.pinnacleAway] : [params.localHome, params.pinnacleHome])
      .filter(Boolean).map(escapeRegExp);
    const followedByOtherTeam = otherTeam.length > 0
      ? new RegExp(`^(?:or|ou)\\s+(?:${otherTeam.join("|")})(?![\\p{L}\\p{N}])`, "iu")
      : null;
    out = out.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(local)}(?![\\p{L}\\p{N}])`, "giu"),
      (match, offset: number, source: string) => {
        const suffix = source.slice(offset + match.length).trimStart();
        const safeSuffix =
          suffix.length === 0 ||
          /^(?:[+\-−–—]?\d|over\b|under\b|mais\b|menos\b|acima\b|abaixo\b|to win\b|para vencer\b|moneyline\b|ml\b|dnb\b|(?:or|ou)\s+(?:draw|empate)\b)/iu.test(
            suffix,
          ) ||
          Boolean(followedByOtherTeam?.test(suffix));
        return safeSuffix ? pinn : match;
      },
    );
  }
  return rewriteNationalTeamsInText(out, [params.pinnacleHome, params.pinnacleAway]);
}
