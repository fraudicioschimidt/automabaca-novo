import { ehMercadoArtilheiro } from "@/src/domain/settlement/goalscorer";
import { tokensDaSelecao, type PlayerPropKey, type PlayerPropStats } from "@/src/domain/settlement/goalscorer-matching";
import { prefixoAntesDaLinha } from "@/src/domain/settlement/over-under-subject";
import { matchTeamSide } from "@/src/domain/settlement/sides";
import { marketPeriodOf } from "@/src/domain/mercados/classify";
import { isBothTeamsCardsText } from "@/src/domain/mercados/stat-qualifier";
import { canonicalSport } from "@/src/domain/sports/registry";
import { normalizeStr } from "@/src/domain/text";

export type PlayerPropFamily =
  | "fouls_suffered"
  | "fouls_committed"
  | "passes_total"
  | "passes_completed"
  | "shots_total"
  | "shots_on_target"
  | "tackles_total"
  | "tackles_won"
  | "cards_any"
  | "cards_yellow"
  | "cards_red"
  | "assists"
  | "interceptions"
  | "key_passes"
  | "offsides"
  | "saves_total";

/** Rótulos finais de produto — settlement FlashScore, sem odds na cascata. */
export const MERCADO_DA_PROP: Record<PlayerPropFamily, string> = {
  fouls_suffered: "Player Fouls Suffered",
  fouls_committed: "Player Fouls",
  passes_total: "Player Passes",
  passes_completed: "Player Passes Completed",
  shots_total: "Player Shots",
  shots_on_target: "Player Shots on Target",
  tackles_total: "Player Tackles",
  tackles_won: "Player Tackles Won",
  cards_any: "Player Cards",
  cards_yellow: "Player Yellow Cards",
  cards_red: "Player Red Cards",
  assists: "Player Assists",
  interceptions: "Player Interceptions",
  key_passes: "Player Key Passes",
  offsides: "Player Offsides",
  saves_total: "Player Saves",
};

/** Singular e plural: o aviso e a ficha dizem "1 chute no gol", "2 chutes no gol". */
const PROP_STAT_LABEL: Record<PlayerPropFamily, readonly [string, string]> = {
  fouls_suffered: ["falta sofrida", "faltas sofridas"],
  fouls_committed: ["falta", "faltas"],
  passes_total: ["passe", "passes"],
  passes_completed: ["passe certo", "passes certos"],
  shots_total: ["chute", "chutes"],
  shots_on_target: ["chute no gol", "chutes no gol"],
  tackles_total: ["desarme", "desarmes"],
  tackles_won: ["desarme ganho", "desarmes ganhos"],
  cards_any: ["cartão", "cartões"],
  cards_yellow: ["cartão amarelo", "cartões amarelos"],
  cards_red: ["cartão vermelho", "cartões vermelhos"],
  assists: ["assistência", "assistências"],
  interceptions: ["interceptação", "interceptações"],
  key_passes: ["passe-chave", "passes-chave"],
  offsides: ["impedimento", "impedimentos"],
  saves_total: ["defesa", "defesas"],
};

/**
 * A estatística da prop em PT, concordando com o valor ("chutes no gol"), no
 * aviso de liquidação e na ficha. A família chega de JSON gravado: a
 * desconhecida volta crua em vez de sumir.
 */
export function propStatLabel(family: string, value: number): string {
  if (!Object.hasOwn(PROP_STAT_LABEL, family)) return family;
  const [singular, plural] = PROP_STAT_LABEL[family as PlayerPropFamily];
  return Math.abs(value) === 1 ? singular : plural;
}

const MERCADO_CANONICO: ReadonlyArray<{ re: RegExp; family: PlayerPropFamily }> = [
  { re: /\bplayer passes completed\b/, family: "passes_completed" },
  { re: /\bplayer passes\b/, family: "passes_total" },
  { re: /\bplayer tackles won\b/, family: "tackles_won" },
  { re: /\bplayer yellow cards?\b/, family: "cards_yellow" },
  { re: /\bplayer red cards?\b/, family: "cards_red" },
  { re: /\bplayer fouls suffered\b|\bfaltas sofridas\b/, family: "fouls_suffered" },
  { re: /\bplayer fouls\b|\bfaltas d[oa] jogador/, family: "fouls_committed" },
  { re: /\bplayer shots on target\b|\bchutes no gol d[oa] jogador/, family: "shots_on_target" },
  { re: /\bplayer shots\b|\bchutes d[oa] jogador/, family: "shots_total" },
  { re: /\bplayer tackles\b|\bdesarmes d[oa] jogador/, family: "tackles_total" },
  { re: /\bplayer cards\b|\bcartoes? d[oa] jogador/, family: "cards_any" },
  { re: /\bplayer assists\b|\bassistencias? d[oa] jogador/, family: "assists" },
  { re: /\bplayer interceptions?\b|\bintercepta(?:cao|coes) d[oa] jogador/, family: "interceptions" },
  { re: /\bplayer key passes?\b|\bpasses? (?:chave|decisivos?) d[oa] jogador/, family: "key_passes" },
  { re: /\bplayer offsides?\b|\bimpedimentos? d[oa] jogador/, family: "offsides" },
  { re: /\bplayer saves?\b|\bdefesas? d[oa] (?:jogador|goleir[oa])/, family: "saves_total" },
];

const PROP_DE_JOGADOR = /\b(?:player|jogador|jogadora|atleta)\b/;

export type PlayerPropClassificacao = {
  family: PlayerPropFamily;
  mercado: string;
  /** Ausente significa FT; períodos parciais ficam explícitos e são recusados. */
  period?: Exclude<ReturnType<typeof marketPeriodOf>, "FT">;
};

function familiaNoTexto(text: string): PlayerPropFamily | null {
  if (
    /\b(?:sofre|sofrida|sofridas|suffered)\s+(?:falta|faltas|foul|fouls)\b/.test(text) ||
    /\b(?:falta|faltas|foul|fouls)\s+(?:sofrida|sofridas|suffered)\b/.test(text) ||
    /\bfouls?\s+suffered\b/.test(text)
  ) {
    return "fouls_suffered";
  }
  if (
    /\b(?:comete|cometida|cometidas|committed)\s+(?:falta|faltas|foul|fouls)\b/.test(text) ||
    /\b(?:falta|faltas|foul|fouls)\s+(?:cometida|cometidas|committed)\b/.test(text) ||
    /\bfouls?\s+committed\b/.test(text)
  ) {
    return "fouls_committed";
  }
  if (/\b(?:remate|remates|chute|chutes|shot|shots|finalizacao|finalizacoes)\b/.test(text)) {
    if (/\b(?:on\s+(?:target|goal)|ao?\s+gol|no\s+gol|no\s+alvo|a\s+baliza|a\s+porta)\b/.test(text)) {
      return "shots_on_target";
    }
    return "shots_total";
  }
  if (/\b(?:desarme|desarmes|tackle|tackles)\b/.test(text)) {
    if (/\b(?:ganho|ganhos|certo|certos|won)\b/.test(text)) return "tackles_won";
    return "tackles_total";
  }
  if (/\b(?:cartao|cartoes|card|cards|booking|bookings)\b/.test(text)) {
    if (/\b(?:red|vermelh[oa]s?)\b/.test(text)) return "cards_red";
    if (/\b(?:yellow|amarel[oa]s?)\b/.test(text)) return "cards_yellow";
    return "cards_any";
  }
  if (/\b(?:assistencia|assistencias|assist|assists)\b/.test(text)) return "assists";
  if (/\b(?:interceptacao|interceptacoes|interception|interceptions)\b/.test(text)) {
    return "interceptions";
  }
  if (
    /\b(?:key\s+passes?|passes?\s+chave|passes?\s+decisivos?)\b/.test(text)
  ) {
    return "key_passes";
  }
  if (/\b(?:impedimento|impedimentos|offside|offsides)\b/.test(text)) return "offsides";
  if (/\b(?:defesa|defesas|save|saves)\b/.test(text)) return "saves_total";
  if (/\b(?:passe|passes)\b/.test(text)) {
    return /\b(?:completo|completos|certo|certos|completed|accurate)\b/.test(text) ? "passes_completed" : "passes_total";
  }
  if (/\b(?:falta|faltas|foul|fouls)\b/.test(text)) return "fouls_committed";
  return null;
}

function especializa(base: PlayerPropFamily, detalhe: PlayerPropFamily): boolean {
  if (base === "passes_total" && detalhe === "passes_completed") return true;
  if (base === "shots_total" && detalhe === "shots_on_target") return true;
  if (base === "tackles_total" && detalhe === "tackles_won") return true;
  if (base === "cards_any" && (detalhe === "cards_yellow" || detalhe === "cards_red")) {
    return true;
  }
  return false;
}

function contradiz(a: PlayerPropFamily, b: PlayerPropFamily): boolean {
  if (a === b || especializa(a, b) || especializa(b, a)) return false;
  return true;
}

/**
 * A seleção/mercado pede uma estatística de JOGADOR? Sem nome casável contra
 * o evento, "Bahia over 8.5 faltas" continua faltas de TIME.
 *
 * Anytime Goalscorer fica de fora: tem caminho próprio (`GOALS`).
 */
export function classificarPropDeJogador(params: {
  mercado: string;
  selecao: string;
  evento?: string;
  esporte?: string;
}): PlayerPropClassificacao | null {
  if (ehMercadoArtilheiro(params.mercado)) return null;
  // O endpoint e as chaves desta fase são contrato medido apenas no futebol.
  // Quando o caller conhece a modalidade, ausência/ambiguidade também recusa.
  if (params.esporte !== undefined && canonicalSport(params.esporte) !== "Soccer") {
    return null;
  }
  const mercadoN = normalizeStr(params.mercado);
  const selecaoN = normalizeStr(params.selecao);
  const combinado = `${mercadoN} ${selecaoN}`;
  // Mercado coletivo conhecido vem antes da heurística de nome: "Both Teams"
  // não é atleta e cada lado atingir a linha não é soma individual.
  if (isBothTeamsCardsText(combinado)) return null;
  if (/\b(?:both teams|ambas(?: as equipes)?|ambos(?: os times)?)\b/.test(combinado)) {
    return null;
  }

  const canonico = MERCADO_CANONICO.find((item) => item.re.test(mercadoN));
  const pelaSelecao = familiaNoTexto(selecaoN);
  const peloMercadoJogador = PROP_DE_JOGADOR.test(mercadoN)
    ? familiaNoTexto(mercadoN)
    : null;

  let family: PlayerPropFamily | null = null;
  if (canonico) {
    family = canonico.family;
  } else if (peloMercadoJogador) {
    family = peloMercadoJogador;
  } else if (pelaSelecao) {
    family = pelaSelecao;
  }
  if (!family) return null;
  if (peloMercadoJogador && contradiz(family, peloMercadoJogador)) return null;
  if (peloMercadoJogador && especializa(family, peloMercadoJogador)) family = peloMercadoJogador;
  if (pelaSelecao && contradiz(family, pelaSelecao)) return null;
  if (pelaSelecao && especializa(family, pelaSelecao)) family = pelaSelecao;

  const marcadoComoJogador = Boolean(canonico) || PROP_DE_JOGADOR.test(combinado);
  const prefixo = prefixoAntesDaLinha(params.selecao);
  const prefixoETime = Boolean(
    prefixo && params.evento && matchTeamSide(prefixo, params.evento),
  );
  if (prefixoETime && !marcadoComoJogador) return null;

  const sofreOuComete =
    family === "fouls_suffered" ||
    (family === "fouls_committed" &&
      /\b(?:comete|cometida|cometidas|committed)\b/.test(combinado));
  // Nome de jogador na forma tipster: "Fulano over 0.5 …". Sem a direção,
  // o texto antes do número é rótulo de mercado ("Cartões Amarelos Over",
  // "Ambas recebem +2 cards"), não um atleta.
  const prefixoEStat = Boolean(prefixo && familiaNoTexto(prefixo));
  const temNomeDeJogador =
    Boolean(prefixo) &&
    !prefixoETime &&
    !prefixoEStat &&
    tokensDaSelecao(params.selecao).length > 0;
  if (!marcadoComoJogador && !sofreOuComete && !temNomeDeJogador) return null;
  // Sem evento, nome+faltas não distingue "Emmanuel Martinez" de "Flamengo".
  // Settlement sempre tem evento; cobertura/odds sem evento só aceita marca explícita.
  if (!marcadoComoJogador && !sofreOuComete && !params.evento) return null;

  const period = marketPeriodOf(`${params.mercado} ${params.selecao}`, params.esporte);
  return {
    family,
    mercado: MERCADO_DA_PROP[family],
    ...(period === "FT" ? {} : { period }),
  };
}

/**
 * A chave do FlashScore `player-stats` de cada família. Ausência da chave ≠ 0:
 * falha fechado, não inventa zero. `cards_any` não tem chave única: a casa pode
 * contar amarelo, vermelho direto e segundo amarelo de formas distintas, e sem
 * contrato por casa a prop genérica permanece manual.
 */
const CHAVE_DA_FAMILIA: Readonly<Record<Exclude<PlayerPropFamily, "cards_any">, PlayerPropKey>> = {
  fouls_suffered: "FOULS_SUFFERED",
  fouls_committed: "FOULS_COMMITTED",
  passes_total: "PASSES_TOTAL",
  passes_completed: "PASSES_ACCURATE",
  shots_total: "SHOTS_TOTAL",
  shots_on_target: "SHOTS_ON_TARGET",
  tackles_total: "TACKLES_TOTAL",
  tackles_won: "TACKLES_WON",
  assists: "ASSISTS_GOAL",
  interceptions: "INTERCEPTIONS",
  key_passes: "KEY_PASSES",
  offsides: "OFFSIDES",
  saves_total: "SAVES_TOTAL",
  cards_yellow: "CARDS_YELLOW",
  cards_red: "CARDS_RED",
};

export function valorDaProp(
  family: PlayerPropFamily,
  stats: PlayerPropStats,
): number | undefined {
  return family === "cards_any" ? undefined : stats[CHAVE_DA_FAMILIA[family]];
}

export function chaveDaProp(family: PlayerPropFamily): string {
  return family === "cards_any" ? "CARDS_YELLOW|CARDS_RED|CARDS_YELLOW_SECOND" : CHAVE_DA_FAMILIA[family];
}
