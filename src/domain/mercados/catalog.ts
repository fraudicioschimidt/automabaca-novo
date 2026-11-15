import { normalizeStr } from "@/src/domain/text";
import {
  MERCADO_CATALOG,
  type MercadoCatalogName,
} from "@/src/domain/mercados/catalog-data";

/**
 * Catálogo aceito na entrada + labels FINAIS Pinnacle (Config/seed).
 * Intermediários sport-aware (`Asian Handicap`, `Total`, `Moneyline`) continuam aceitos
 * para o finalize mapear por esporte; a Config lista só os finais.
 */
export const MERCADOS_INTERMEDIARIOS = [
  "Asian Handicap",
  "Asian Handicap Cards",
  "Asian Handicap Corners",
  "Asian Total Cards",
  "Asian Total Corners",
  "1st Half Asian Corners",
  "Cards",
  "Cards O/U",
  "Corners",
  "Corners O/U",
  "Total",
  "Total Cards",
  "Moneyline",
  // Forma de entrada transitória: a captura converte DNB para o handicap
  // Pinnacle do esporte com linha zero antes de persistir.
  "Draw No Bet",
  "Player Props",
  "Player Points/Rebounds/Assists",
  "Player Points",
  "Player Rebounds",
  "Player Assists",
  "Shots",
  "Shots On Target",
] as const;

/**
 * Rótulos FINAIS — vocabulário estritamente Pinnacle (pinnacle.com/en).
 * É contra esta lista que a página Config > Mercados e a integridade de dados medem.
 */
export const MERCADOS_FINAIS = Object.freeze(
  Object.keys(MERCADO_CATALOG) as MercadoCatalogName[],
);

export type MercadoFinal = (typeof MERCADOS_FINAIS)[number];

/** Tudo que `resolveMercadoStatic` aceita: entrada + final. */
export const CANONICAL_MARKETS = [...MERCADOS_INTERMEDIARIOS, ...MERCADOS_FINAIS] as const;

/**
 * Traduções diretas PT/legado → intermediário ou final (defensivas).
 */
export const MERCADO_TRANSLATIONS: Record<string, string> = {
  "Total – Partida": "Total",
  "Resultado Final": "Moneyline",
  "Para Ganhar": "Moneyline",
  "Para Ganhar a Partida": "Moneyline",
  "Para Vencer a Partida": "Moneyline",
  "Mais/Menos": "Total",
  "Total de Pontos": "Total Points",
  "Gols + -": "Total",
  "Gols +-": "Total",
  "Gols +/-": "Total",
  "Gols Mais/Menos": "Total",
  "Gols Acima/Abaixo": "Total",
  "Handicap Asiático": "Asian Handicap",
  "Handicap Asiatico": "Asian Handicap",
  "Hándicap Asiático": "Asian Handicap",
  "Handicap Asiático - Cartões": "Asian Handicap Cards",
  "Handicap Asiático de Cartões": "Asian Handicap Cards",
  "Handicap Asiático - Escanteios": "Asian Handicap Corners",
  "Handicap Asiático de Escanteios": "Asian Handicap Corners",
  "Handicap (incl. entradas extras)": "Asian Handicap",
  "Handicap (incl. extra innings)": "Asian Handicap",
  "Ambas Marcam": "Both Teams to Score",
  "Ambos Marcam": "Both Teams to Score",
  "Ambas Equipes Marcam": "Both Teams to Score",
  "Gol/Gol": "Both Teams to Score",
  "Both Score": "Both Teams to Score",
  "Chance Dupla": "Double Chance",
  "Double Chance – Match": "Double Chance",
  "Double Chance - Match": "Double Chance",
  "Empate Anula a Aposta": "Draw No Bet",
  "Empate Anula": "Draw No Bet",
  "Aposta Sem Empate": "Draw No Bet",
  "Sem Empate": "Draw No Bet",
  "Tie No Bet": "Draw No Bet",
  "Handicap - Partida": "Asian Handicap",
  "Handicap (Soccer) – Match": "Asian Handicap",
  "Handicap (Asian) - Match": "Asian Handicap",
  "Asian Handicap (Bookings) – Match": "Asian Handicap Cards",
  "Handicap da Partida": "Asian Handicap",
  "Handicap - 2 Opções": "Asian Handicap",
  "Handicap - 2 Opcoes": "Asian Handicap",
  "Handicap 2 Opções": "Asian Handicap",
  "Handicap 2 Opcoes": "Asian Handicap",
  "Handicap 2 Vias": "Asian Handicap",
  "Handicap - 2 Vias": "Asian Handicap",
  "Handicap de Rounds da Partida": "Asian Handicap",
  "Handicap de Rounds": "Asian Handicap",
  "Total de Rounds da Partida": "Total",
  "Total de Rounds": "Total",
  "Total (Gols) – Match": "Total",
  "Total de Gols": "Total",
  "Goal Line": "Total",
  "Linha de Gols": "Total",
  "Linha de Gol": "Total",
  "Asian Goal Line": "Total",
  "Goal Line Asiático": "Total",
  "Goal Line Asiatico": "Total",
  "Linha de Escanteios": "Corners",
  "Total de Escanteios": "Corners",
  "Mais/Menos Escanteios": "Corners",
  "Over/Under Escanteios": "Corners",
  "Asian Corners": "Total (Corners) – Match",
  "Linha de Cartões": "Cards",
  "Linha de Cartoes": "Cards",
  "1st Half Total Corners": "Total (Corners) – 1st Half",
  "1º Tempo - Total Escanteios": "Total (Corners) – 1st Half",
  "Handicap de Pontos": "Asian Handicap",
  "Marcar a Qualquer Momento": "Anytime Goalscorer",
  "Para Marcar a Qualquer Momento": "Anytime Goalscorer",
  "Primeiro a Marcar": "First Goalscorer",
  "Primeiro Marcador": "First Goalscorer",
  "Último a Marcar": "Last Goalscorer",
  "Ultimo a Marcar": "Last Goalscorer",
  "Último Marcador": "Last Goalscorer",
  "Ultimo Marcador": "Last Goalscorer",
  "Resultado Intervalo": "Money Line – 1st Half",
  "1st Half Moneyline": "Money Line – 1st Half",
  "1st Half Handicap": "Handicap – 1st Half",
  "1st Half Total": "Total – 1st Half",
  "Half Time Result": "Money Line – 1st Half",
  "Total de Cartões": "Total (Bookings) – Match",
  "Total do Time": "Team Total",
  "Total de Gols do Time": "Team Total",
  "Total da Equipe": "Team Total",
  "Time 1 - Total": "Team Total",
  "Time 1 Total": "Team Total",
  "Time 2 - Total": "Team Total",
  "Time 2 Total": "Team Total",
  "Time da Casa - Total": "Team Total",
  "Time Visitante - Total": "Team Total",
  Cartões: "Cards",
  Escanteios: "Corners",
  "Placar Exato": "Correct Score",
  "1º Tempo - Para Ganhar": "Money Line – 1st Half",
  "1º Tempo - Totais": "Total – 1st Half",
  "1T Totais": "Total – 1st Half",
  "1T - Totais": "Total – 1st Half",
  "Totais 1T": "Total – 1st Half",
  "Primeiro mapa - total kills": "Total (Kills) – Map 1",
  "Segundo mapa - total kills": "Total (Kills) – Map 2",
  "Terceiro mapa - total kills": "Total (Kills) – Map 3",
  "Quarto mapa - total kills": "Total (Kills) – Map 4",
  "Quinto mapa - total kills": "Total (Kills) – Map 5",
  "1º mapa - total kills": "Total (Kills) – Map 1",
  "2º mapa - total kills": "Total (Kills) – Map 2",
  "3º mapa - total kills": "Total (Kills) – Map 3",
  "4º mapa - total kills": "Total (Kills) – Map 4",
  "5º mapa - total kills": "Total (Kills) – Map 5",
  anytime: "Anytime Goalscorer",
  "anytime goalscorer": "Anytime Goalscorer",
  "any 1° gol": "First Goalscorer",
  "any 1º gol": "First Goalscorer",
  "any 1o gol": "First Goalscorer",
  "1° gol": "First Goalscorer",
  "1º gol": "First Goalscorer",
  "1o gol": "First Goalscorer",
  "primeiro gol": "First Goalscorer",
  deaths: "Player Props",
  kills: "Player Props",
  abates: "Player Props",
  mortes: "Player Props",
  "deaths ht": "Player Props",
  "deaths HT": "Player Props",
  "kills ht": "Player Props",
  "kills HT": "Player Props",
  "player kills": "Player Props",
  "player deaths": "Player Props",
  "P + A + R": "Player Points/Rebounds/Assists",
  "p + a + r": "Player Points/Rebounds/Assists",
  "P+A+R": "Player Points/Rebounds/Assists",
  "p+a+r": "Player Points/Rebounds/Assists",
  PRA: "Player Points/Rebounds/Assists",
  pra: "Player Points/Rebounds/Assists",
  "pontos + rebotes + assistências": "Player Points/Rebounds/Assists",
  "pontos + rebotes + assistencias": "Player Points/Rebounds/Assists",
  // "Pontos" ou "rebotes" sozinhos são uma estatística só: levá-los ao PRA
  // faria a liquidação somar pontos, rebotes e assistências.
  pontos: "Player Points",
  rebotes: "Player Rebounds",
  "ass": "Player Assists",
  "assist": "Player Assists",
  "assists": "Player Assists",
  "assistência": "Player Assists",
  "assistencias": "Player Assists",
  "assistências": "Player Assists",
  "player assists": "Player Assists",
  "chutes": "Shots",
  "chutes do jogador": "Shots",
  "finalizacoes": "Shots",
  "finalizações": "Shots",
  "player shots": "Shots",
  "chutes ao gol": "Shots On Target",
  "chutes no gol": "Shots On Target",
  "chutes a gol": "Shots On Target",
  "finalizacoes no alvo": "Shots On Target",
  "finalizações no alvo": "Shots On Target",
  "player shots on target": "Shots On Target",
  "2+ gols": "To Score 2+ Goals",
  "marcar 2+ gols": "To Score 2+ Goals",
  "marcar 2 ou mais gols": "To Score 2+ Goals",
  "to score 2+ goals": "To Score 2+ Goals",
  "3+ gols": "To Score 3+ Goals",
  "marcar 3+ gols": "To Score 3+ Goals",
  "marcar 3 ou mais gols": "To Score 3+ Goals",
  "to score 3+ goals": "To Score 3+ Goals",
  "hat-trick": "To Score 3+ Goals",
  "to score a hat-trick": "To Score 3+ Goals",
};

/** Chave de lookup de alias: minúsculo, sem acento, só [a-z0-9] e espaço. */
export function normalizeMercadoKey(s: string): string {
  return normalizeStr(s)
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CANONICAL_BY_KEY = new Map<string, string>(
  CANONICAL_MARKETS.map((m) => [normalizeMercadoKey(m), m]),
);
const TRANSLATION_BY_KEY = new Map<string, string>(
  Object.entries(MERCADO_TRANSLATIONS).map(([k, v]) => [normalizeMercadoKey(k), v]),
);

/** Resolve apenas nomes canônicos, sem aplicar aliases/traduções. */
export function resolveMercadoCanonical(raw: string): string | null {
  const key = normalizeMercadoKey(raw);
  if (!key) return null;
  return CANONICAL_BY_KEY.get(key) ?? null;
}

/** Resolve direto contra catálogo + traduções estáticas (sem banco). */
export function resolveMercadoStatic(raw: string): string | null {
  const key = normalizeMercadoKey(raw);
  if (!key) return null;
  return resolveMercadoCanonical(raw) ?? TRANSLATION_BY_KEY.get(key) ?? null;
}

const FINAIS_POR_CHAVE = new Set(MERCADOS_FINAIS.map((m) => normalizeMercadoKey(m)));

/**
 * O mercado gravado está no vocabulário canônico Pinnacle?
 */
export function isMercadoFinal(mercado: string): boolean {
  return FINAIS_POR_CHAVE.has(normalizeMercadoKey(mercado));
}
