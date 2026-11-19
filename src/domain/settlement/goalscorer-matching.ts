import { normalizeStr } from "@/src/domain/text";

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

const PARTICULAS = new Set([
  "de", "da", "do", "das", "dos", "del", "della", "di", "du",
  "van", "von", "der", "den", "ter", "el", "al", "bin", "ibn", "la", "le",
  "jr", "junior", "filho", "neto", "sr", "senior",
]);

/** Similaridade mínima para liquidar sozinho. */
export const GOALSCORER_MIN_SIMILARIDADE = 0.82;
/**
 * Distância mínima até o segundo colocado. Dois "Silva" na mesma partida têm
 * que virar caso de treino, não um chute com cara de decisão.
 */
export const GOALSCORER_MIN_VANTAGEM = 0.15;

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
  return jogador.minutosJogados === undefined && jogador.participou !== true && jogador.gols === 0;
}

/**
 * O feed mostra o jogador no elenco com zero minuto e sem gol: não entrou. As
 * casas anulam a aposta de gol de quem não entrou, então ela sai VOID.
 */
export function listedButDidNotPlay(jogador: JogadorDaPartida): boolean {
  return jogador.minutosJogados !== undefined && jogador.minutosJogados <= 0 &&
    jogador.participou !== true && jogador.gols === 0;
}

/**
 * Palavras do MERCADO que a casa cola no nome do jogador ("Haaland - Marcar a
 * qualquer momento", "Vinicius Jr Sim"). Removidas por TOKEN, nunca por regex
 * sobre o texto cru — ver `nomeDaSelecao`.
 */
const PALAVRAS_DE_MERCADO = new Set([
  "marcar", "para", "anytime", "goalscorer", "scorer", "qualquer", "momento",
  "sim", "nao", "yes", "no", "gol", "gols", "goal", "goals",
  // Props de jogador (Fase 1): a seleção cola over/under e a estatística no
  // nome ("willian jose over 0,5 sofre falta"). Sem isto o matcher tenta
  // casar "sofre"/"falta" contra o feed e falha fechado à toa.
  "over", "under", "mais", "menos", "acima", "abaixo",
  "falta", "faltas", "foul", "fouls", "sofre", "sofrida", "sofridas", "suffered",
  "comete", "cometida", "cometidas", "committed",
  "remate", "remates", "baliza", "porta", "completed", "accurate", "completos", "completo",
  "chute", "chutes", "shot", "shots", "finalizacao", "finalizacoes",
  "alvo", "target", "desarme", "desarmes", "tackle", "tackles",
  "ganho", "ganhos", "certo", "certos", "won",
  "cartao", "cartoes", "card", "cards", "amarelo", "amarelos", "vermelho", "vermelhos",
  "yellow", "red", "booking", "bookings",
  "assistencia", "assistencias", "assist", "assists",
  "interceptacao", "interceptacoes", "interception", "interceptions",
  "key", "passe", "passes", "chave", "decisivo", "decisivos",
  "impedimento", "impedimentos", "offside", "offsides",
  "defesa", "defesas", "save", "saves",
  "jogador", "jogadora", "player", "atleta",
  "total", "totais", "on",
  // Quantidade de gols ("Haaland 3+", "Haaland hat-trick", "2 ou mais"): quem
  // lê a quantidade é `requiredPlayerGoals`; aqui só não pode virar nome.
  "hat", "trick", "tricks", "hattrick", "brace", "bis", "ou", "or", "more", "least", "minimo",
]);

/** Palavras do texto sem acento e sem pontuação; hífen separa como espaço. */
function palavrasNormalizadas(texto: string): string[] {
  return normalizeStr(texto)
    .replace(/[.'`´]/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((token) => token.length > 0);
}

/** Tokens comparáveis: sem acento, sem pontuação, sem partícula. */
export function tokensDoNome(nome: string): string[] {
  return palavrasNormalizadas(nome).filter((token) => !PARTICULAS.has(token));
}
/** true quando `curto` é abreviação plausível de `longo` ("f" para "franco"). */
function ehInicialDe(curto: string, longo: string): boolean {
  return curto.length === 1 && longo.startsWith(curto);
}

/**
 * Similaridade 0..1 entre o nome da seleção e o nome do feed, **sem ordem**.
 *
 * Cada token do lado MENOR busca par no lado maior: igual vale 1, inicial vale
 * 0.5 (é evidência fraca — "F." casa com Franco, Fernando e Felipe). A nota é a
 * soma dos pares sobre o tamanho do lado menor, com teto pela fração do lado
 * maior que ficou coberta: assim "Silva" sozinho não vira 1.0 contra
 * "Silva Rodrigo".
 */
export function similaridadeDeTokens(
  ta: readonly string[],
  tb: readonly string[],
): number {
  if (ta.length === 0 || tb.length === 0) return 0;

  const [menor, maior] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const disponiveis = [...maior];
  let pontos = 0;
  let pareados = 0;
  for (const token of menor) {
    const exato = disponiveis.findIndex((outro) => outro === token);
    if (exato >= 0) {
      disponiveis.splice(exato, 1);
      pontos += 1;
      pareados += 1;
      continue;
    }
    const inicial = disponiveis.findIndex(
      (outro) => ehInicialDe(token, outro) || ehInicialDe(outro, token),
    );
    if (inicial >= 0) {
      disponiveis.splice(inicial, 1);
      pontos += 0.5;
      pareados += 1;
    }
  }
  if (pontos === 0) return 0;

  const notaMenor = pontos / menor.length;
  // Cobertura do lado maior: um sobrenome isolado casando com nome completo
  // cai para ~0.5 e não passa no limiar sozinho.
  const cobertura = pareados / maior.length;
  return notaMenor * (0.5 + 0.5 * cobertura);
}

/**
 * Tokens do nome do jogador na seleção, já sem o vocabulário do mercado.
 *
 * Filtra por TOKEN, depois de `tokensDoNome` normalizar. Regex sobre o texto
 * CRU não serve: em JS `\b` trata letra acentuada como não-palavra, então
 * `\bsim\b` casaria dentro de "Simão" ("Simão" → "ão") e `\bno\b` dentro de
 * "Noé", e o alerta diria que nenhum jogador bate com um nome que nós mesmos
 * destruímos.
 */
export function tokensDaSelecao(selecao: string): string[] {
  const semSufixoDeMercado = selecao.split(/\s+[-–—]\s+/)[0] ?? selecao;
  return tokensDoNome(semSufixoDeMercado).filter(
    (token) => !PALAVRAS_DE_MERCADO.has(token) && !/^\d+$/.test(token),
  );
}

/**
 * Tokens que NEGAM o gol. `PALAVRAS_DE_MERCADO` os apaga junto com "marcar" e
 * "anytime" — só que "marcar" é ruído e "não" é o LADO DA APOSTA. Apagados,
 * "Haaland - Não" viraria "Haaland" e o veredito sairia `WON` com o jogador
 * tendo marcado: dinheiro invertido, sem revisão humana.
 *
 * Detecta por TOKEN sobre o texto NORMALIZADO, nunca por regex no cru: `\bno\b`
 * casa dentro de "Noé" e `\bnao\b` morre em "Não" acentuado. E olha
 * a seleção INTEIRA, sem cortar no sufixo de mercado — é justamente no sufixo
 * (" - Não") que a casa costuma pôr a polaridade.
 */
const NEGACOES = new Set(["nao", "not", "sem", "never", "nunca"]);

/**
 * "no" é AMBÍGUO: negação em inglês ("Haaland - No", "No Goalscorer") e
 * PREPOSIÇÃO em português ("marcar no 1º tempo"). Tratá-lo sempre como negação
 * recusaria todo mercado de gol por tempo escrito em português.
 *
 * Conta como negação onde a casa de fato põe o rótulo: no FIM do texto, ou
 * imediatamente antes do substantivo negado.
 */
const NEGADOS_APOS_NO = new Set([
  "goal", "goals", "gol", "gols", "score", "scorer", "goalscorer", "anytime",
]);

export function temPolaridadeNegativa(...textos: ReadonlyArray<string | null | undefined>): boolean {
  return textos.some((texto) => {
    if (!texto) return false;
    const tokens = palavrasNormalizadas(texto);
    return tokens.some((token, indice) => {
      if (NEGACOES.has(token)) return true;
      if (token !== "no") return false;
      const proximo = tokens[indice + 1];
      return proximo === undefined || NEGADOS_APOS_NO.has(proximo);
    });
  });
}

/**
 * Casa o nome da seleção com a lista da partida. Mesmo limiar e unicidade do
 * artilheiro — props de jogador não podem ter um matcher mais frouxo.
 */
export function encontrarJogadorNaPartida<T extends JogadorNomeado>(
  selecao: string,
  jogadores: readonly T[],
): PlayerNameMatch<T> {
  const alvo = tokensDaSelecao(selecao);
  if (alvo.length === 0) {
    return { ok: false, reason: "selecao_sem_jogador" };
  }
  if (jogadores.length === 0) {
    return { ok: false, reason: "sem_jogadores" };
  }

  const notas = jogadores
    .map((jogador) => {
      const nome = tokensDoNome(jogador.nome);
      const curto = jogador.nomeCurto ? tokensDoNome(jogador.nomeCurto) : [];
      return {
        jogador,
        tokens: [...nome, ...curto],
        nota: Math.max(similaridadeDeTokens(alvo, nome), curto.length > 0 ? similaridadeDeTokens(alvo, curto) : 0),
      };
    })
    .sort((x, y) => y.nota - x.nota);

  const unico = alvo[0];
  if (alvo.length === 1 && unico && unico.length >= 3) {
    const exatos = notas.filter(({ tokens }) => tokens.includes(unico));
    const so = exatos[0];
    if (exatos.length === 1 && so) {
      return {
        ok: true,
        jogador: so.jogador,
        similaridade: so.nota,
        vantagem: so.nota - (notas.find((item) => item !== so)?.nota ?? 0),
      };
    }
    if (exatos.length > 1) {
      return {
        ok: false,
        reason: "jogador_ambiguo",
        candidatos: exatos.map((item) => item.jogador.nome),
      };
    }
  }

  const melhor = notas[0];
  if (!melhor || melhor.nota < GOALSCORER_MIN_SIMILARIDADE) {
    return { ok: false, reason: "jogador_nao_encontrado" };
  }
  const segundo = notas[1];
  const vantagem = melhor.nota - (segundo?.nota ?? 0);
  if (segundo && vantagem < GOALSCORER_MIN_VANTAGEM) {
    return {
      ok: false,
      reason: "jogador_ambiguo",
      candidatos: notas
        .filter((item) => melhor.nota - item.nota < GOALSCORER_MIN_VANTAGEM)
        .map((item) => item.jogador.nome),
    };
  }
  return {
    ok: true,
    jogador: melhor.jogador,
    similaridade: melhor.nota,
    vantagem,
  };
}
