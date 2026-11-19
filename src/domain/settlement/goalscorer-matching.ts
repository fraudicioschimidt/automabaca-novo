/**
 * O nome do jogador na seleção contra a lista da partida. A regra mora em
 * Rust (`rust/crates/dominio/src/settlement/goalscorer_matching.rs`), com o
 * vocabulário do mercado e o porquê de cada limiar.
 */
import dominio from "@automabaca/dominio";

export const PLAYER_PROP_KEYS = [
  "FOULS_SUFFERED",
  "FOULS_COMMITTED",
  "PASSES_TOTAL",
  "PASSES_ACCURATE",
  "SHOTS_TOTAL",
  "SHOTS_ON_TARGET",
  "TACKLES_TOTAL",
  "TACKLES_WON",
  "CARDS_YELLOW",
  "CARDS_RED",
  "CARDS_YELLOW_SECOND",
  "ASSISTS_GOAL",
  "INTERCEPTIONS",
  "KEY_PASSES",
  "OFFSIDES",
  "SAVES_TOTAL",
] as const;

export type PlayerPropKey = (typeof PLAYER_PROP_KEYS)[number];

export type PlayerPropStats = Readonly<Partial<Record<PlayerPropKey, number>>>;

/** Similaridade mínima para liquidar sozinho (a vantagem mínima fica no Rust). */
export const [GOALSCORER_MIN_SIMILARIDADE] = dominio.goalscorerThresholds();

export type JogadorNomeado = {
  readonly playerId: string;
  /** Como o feed escreve: `Sobrenome Nome`. */
  readonly nome: string;
  /** Abreviado (`Cristaldo F.`), quando o feed publica. */
  readonly nomeCurto?: string | null;
};

export type JogadorDaPartida = JogadorNomeado & {
  readonly teamId?: string | null;
  readonly participou?: boolean;
  readonly substituido?: boolean;
  readonly gols: number;
  readonly golsContra: number;
  /** Minutos publicados pelo feed; zero prova DNP, ausência não prova entrada. */
  readonly minutosJogados?: number;
  /** Titularidade é evidência auxiliar; reserva com minutos > 0 participou. */
  readonly titular?: boolean | null;
  /** Chaves de prop; ausência da chave não entra no mapa (≠ 0). */
  readonly stats?: PlayerPropStats;
};

export type PlayerNameMatch<T extends JogadorNomeado> =
  | { ok: true; jogador: T; similaridade: number; vantagem: number }
  | {
      ok: false;
      reason: "selecao_sem_jogador" | "sem_jogadores" | "jogador_nao_encontrado" | "jogador_ambiguo";
      candidatos?: string[];
    };

export type GoalscorerResolution =
  | {
      ok: true;
      /** VOID: o jogador estava no elenco e não entrou (regra das casas). */
      status: "WON" | "LOST" | "VOID";
      jogador: JogadorDaPartida;
      similaridade: number;
      /** Segundo colocado, para a evidência mostrar por que não houve dúvida. */
      vantagem: number;
    }
  | { ok: false; reason: GoalscorerRefusal; candidatos?: string[] };

export type GoalscorerRefusal =
  /** O texto da seleção não isola um nome utilizável. */
  | "selecao_sem_jogador"
  /** A partida não trouxe lista de jogadores. */
  | "sem_jogadores"
  /** Ninguém passou do limiar. */
  | "jogador_nao_encontrado"
  /** Dois candidatos empatados — decisão humana. */
  | "jogador_ambiguo"
  /** O casado tem gol contra: a semântica de "marcou" fica em disputa. */
  | "gol_contra_envolvido"
  /** A linha nega o gol ("Haaland - Não"): o veredito seria o INVERSO. */
  | "polaridade_negativa"
  /** Sem gol e sem minutos publicados: não dá para separar "não marcou" de "não entrou". */
  | "participacao_nao_comprovada"
  /** Quantidade de gols que a leitura não entende ("Haaland 2 1/2", "over 1.5"). */
  | "quantidade_de_gols_desconhecida"
  | "periodo_nao_suportado"
  /** Gol de cabeça, nos dois tempos, "ou dar assistência": a lista de jogadores não mede. */
  | "qualificador_sem_contrato";

/**
 * "Não marcou" só vale LOST para quem entrou em campo. Minutos publicados, a
 * escalação ou um gol na partida provam a entrada; sem nenhum dos três, a
 * ausência de gol não prova nada — o mesmo critério das props de jogador.
 */
export function participationUnproven(jogador: JogadorDaPartida): boolean {
  return dominio.participationUnproven(jogador.minutosJogados !== undefined, jogador.participou === true, jogador.gols === 0);
}

/**
 * O feed mostra o jogador no elenco com zero minuto e sem gol: não entrou. As
 * casas anulam a aposta de gol de quem não entrou, então ela sai VOID.
 */
export function listedButDidNotPlay(jogador: JogadorDaPartida): boolean {
  // `Number` faz a conversão que o `<= 0` do JS faria (null vira 0).
  const minutos = jogador.minutosJogados === undefined ? null : Number(jogador.minutosJogados);
  return dominio.listedButDidNotPlay(minutos, jogador.participou === true, jogador.gols === 0);
}

/** Tokens comparáveis: sem acento, sem pontuação, sem partícula. */
export function tokensDoNome(nome: string): string[] {
  return dominio.tokensDoNome(nome);
}

/**
 * Similaridade 0..1 entre o nome da seleção e o nome do feed, sem ordem:
 * igual vale 1, inicial vale 0.5, com teto pela cobertura do lado maior.
 */
export function similaridadeDeTokens(ta: readonly string[], tb: readonly string[]): number {
  return dominio.similaridadeDeTokens([...ta], [...tb]);
}

/** Tokens do nome do jogador na seleção, já sem o vocabulário do mercado. */
export function tokensDaSelecao(selecao: string): string[] {
  return dominio.tokensDaSelecao(selecao);
}

/** Algum dos textos nega o gol ("Haaland - Não", "No Goalscorer"). */
export function temPolaridadeNegativa(...textos: ReadonlyArray<string | null | undefined>): boolean {
  return dominio.temPolaridadeNegativa(textos.map((texto) => texto || ""));
}

const PLAYER_MATCH_REFUSALS = dominio.playerMatchRefusals();

/**
 * Casa o nome da seleção com a lista da partida. Mesmo limiar e unicidade do
 * artilheiro — props de jogador não podem ter um matcher mais frouxo.
 */
export function encontrarJogadorNaPartida<T extends JogadorNomeado>(
  selecao: string,
  jogadores: readonly T[],
): PlayerNameMatch<T> {
  const [code = 0, ...rest] = dominio.encontrarJogadorNaPartida(
    selecao,
    jogadores.map((jogador) => jogador.nome),
    jogadores.map((jogador) => jogador.nomeCurto || ""),
  );
  if (code < 0) {
    const [indice = 0, similaridade = 0, vantagem = 0] = rest;
    return { ok: true, jogador: jogadores[indice] as T, similaridade, vantagem };
  }
  const reason = PLAYER_MATCH_REFUSALS[code] ?? "jogador_nao_encontrado";
  return reason === "jogador_ambiguo"
    ? { ok: false, reason, candidatos: rest.map((indice) => (jogadores[indice] as T).nome) }
    : { ok: false, reason };
}
