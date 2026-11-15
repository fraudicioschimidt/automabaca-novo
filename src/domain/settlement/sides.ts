import {
  canonicalizeTeamName,
  hasProtectedTeamCategoryConflict,
  normalizeStr,
  splitEventoTeams,
  teamSimilarity,
} from "@/src/domain/text";
import {
  doubleChancePattern,
  drawNoBetPattern,
} from "@/src/domain/mercados/draw-vocabulary";
import { SIDE_SCOPE_NOUNS } from "@/src/domain/mercados/match-scope";

/**
 * Lado apostado (casa/fora): tokens explícitos, depois nome do time com MARGEM
 * mínima de similaridade. Empate técnico é ambíguo e devolve null — nunca chuta.
 */

export const HOME_TOKENS = /\b(home|casa|mandante)\b/;
export const AWAY_TOKENS = /\b(away|fora|visitante)\b/;
export const DRAW_TOKENS = /\b(draw|empate|tie)\b/;

const DC_CONNECTIVE_WORDS = ["ou", "or", "e", "y", "and"] as const;
const DC_CONNECTIVE_SYMBOLS = String.raw`\/|\+|&`;
export const DRAW_ALTERNATIVE = new RegExp(
  String.raw`(?:\b(?:${DC_CONNECTIVE_WORDS.join("|")})\b|${DC_CONNECTIVE_SYMBOLS})`,
);
export const DC_SPLIT = new RegExp(
  String.raw`\s*(?:\b(?:${DC_CONNECTIVE_WORDS.join("|")})\b|${DC_CONNECTIVE_SYMBOLS}|\s+-\s+|,)\s*`,
  "i",
);
export const DRAW_NEGATED = /\b(?:no|nao|not|sem|against|contra|anti)\s+(?:draw|empate|tie)\b/;

const DNB_LABEL = drawNoBetPattern(String.raw`\s+`);
export const DNB_ANY = new RegExp(String.raw`\b${DNB_LABEL}\b`);
export const DNB_PREFIX = new RegExp(String.raw`^\s*${DNB_LABEL}\s*[:\-]?\s*`);
export const DNB_SUFFIX = new RegExp(
  String.raw`\s*(?:\(\s*${DNB_LABEL}\s*\)|-\s*${DNB_LABEL}|${DNB_LABEL})\s*$`,
);
export const DOUBLE_CHANCE_LABEL = doubleChancePattern(String.raw`\s+`);

export const SIDE_SCOPE = SIDE_SCOPE_NOUNS.join("|");
const HOME_LABEL_SRC = String.raw`(?:time|equipe|clube|team|club)\s*1|primeiro\s+time|primeira\s+equipe|primeiro\s+clube|1[oaºª]\s*(?:time|equipe|clube)|first\s+(?:team|club)|1st\s+(?:team|club)|local\s+team|(?:vencedor|ganhador)(?:\s+d[oa]\s+(?:${SIDE_SCOPE}))?\s*1|(?:match|event)?\s*winner\s*1`;
const AWAY_LABEL_SRC = String.raw`(?:time|equipe|clube|team|club)\s*2|segundo\s+time|segunda\s+equipe|segundo\s+clube|2[oaºª]\s*(?:time|equipe|clube)|second\s+(?:team|club)|2nd\s+(?:team|club)|visitor\s+team|visiting\s+team|(?:vencedor|ganhador)(?:\s+d[oa]\s+(?:${SIDE_SCOPE}))?\s*2|(?:match|event)?\s*winner\s*2`;
export const HOME_LABEL = new RegExp(`^(?:${HOME_LABEL_SRC})$`);
export const AWAY_LABEL = new RegExp(`^(?:${AWAY_LABEL_SRC})$`);

const ANNOTATION_INNER = String.raw`(?:[+\-]?\s*\d+(?:[.,]\d+)?|${HOME_LABEL_SRC}|${AWAY_LABEL_SRC})`;
export const PARENTHETICAL_ANNOTATION = new RegExp(
  String.raw`\s*(?:\(\s*${ANNOTATION_INNER}\s*\)|\[\s*${ANNOTATION_INNER}\s*\])\s*$`,
);

/**
 * Remove o NOME DO TIME da seleção antes de extrair a linha — inverso de
 * `matchTeamSide`. Sem isto, dígitos do clube ("1. FC Köln", "Schalke 04")
 * vazam para `parseLineQuarters` e corrompem a linha. O lookbehind
 * `(?<![+\-])` preserva o sinal: o "1" do nome não apaga o "+1" do handicap.
 */
export function stripTeamNames(selecao: string, evento: string): string {
  const s = normalizeStr(selecao);
  const teams = splitEventoTeams(evento);
  if (!teams) return s;
  const removableTokens = (team: string): string[] => {
    const tokens = normalizeStr(team).match(/[a-z0-9]+/g) ?? [];
    return tokens.filter((token, index) => {
      if (!/^\d+$/.test(token)) return true;
      // Em `Sub-20`/`Sub 20` (ou `U 20`), 20 descreve a categoria do time,
      // mas pode ser também a linha legítima de `Over 20`. Remover só esse
      // número apagaria a aposta inteira. `U20` já é um token alfanumérico.
      const previous = tokens[index - 1];
      return previous !== "sub" && previous !== "u" && previous !== "under";
    });
  };
  const tokens = [
    ...removableTokens(teams.home),
    ...removableTokens(teams.away),
  ];
  let out = s;
  for (const tok of tokens) {
    // Token numerico de clube ("Schalke 04", "BK 95") nao pode apagar a
    // parte fracionaria de uma linha ("+1.5"). Letras seguem pela regra simples.
    const source = /^\d+$/.test(tok)
      ? `(?<![+\\-\\d.,])\\b${tok}\\b(?![.,]\\d)`
      : `\\b${tok}\\b`;
    out = out.replace(new RegExp(source, "g"), " ");
  }
  return out;
}

const SIDE_MIN_SIMILARITY = 0.72;
const SIDE_MIN_MARGIN = 0.15;

const GENERIC_TEAM_SUBTOKENS = new Set([
  "f", "m", "fc", "sc", "ec", "ac", "cf", "fk", "sk", "bk", "cd", "ca",
  "club", "clube", "de", "da", "do", "das", "dos", "the", "team", "vs", "x", "e",
  "esporte", "deportivo", "atletico", "sporting", "real", "futebol", "women", "ladies", "fem", "feminino",
]);

const BRAZILIAN_STATE_SUFFIXES: Record<string, string> = {
  MG: "Mineiro",
  PR: "Paranaense",
  RJ: "Carioca",
  RS: "Gaucho",
  BA: "Baiano",
  SP: "Paulista",
  CE: "Cearense",
  GO: "Goiano",
};

const BRAZILIAN_STATE_BY_ADJECTIVE = new Map(
  Object.entries(BRAZILIAN_STATE_SUFFIXES).map(([state, adjective]) => [
    normalizeStr(adjective),
    state,
  ]),
);

/**
 * Alias estadual restrito ao matching de LADO. Não entra na canonicalização
 * global porque `canonicalNorm` é identidade persistida e mudar "Operário-PR"
 * para outra chave duplicaria clubes já conhecidos no banco.
 */
function expandBrazilianClubSuffix(team: string): string {
  return team.replace(/(?:-|\s)(MG|PR|RJ|RS|BA|SP|CE|GO)$/i, (_match, state: string) => (
    ` ${BRAZILIAN_STATE_SUFFIXES[state.toUpperCase()] ?? state}`
  ));
}

function brazilianStateIdentity(team: string): string | null {
  const suffix = team.match(/(?:-|\s)(MG|PR|RJ|RS|BA|SP|CE|GO)$/i)?.[1];
  if (suffix) return suffix.toUpperCase();
  const lastToken = normalizeStr(team).split(/\s+/).filter(Boolean).at(-1);
  return lastToken ? BRAZILIAN_STATE_BY_ADJECTIVE.get(lastToken) ?? null : null;
}

function stripBrazilianClubSuffix(team: string): string {
  return team.replace(/(?:-|\s)(?:MG|PR|RJ|RS|BA|SP|CE|GO)$/i, "").trim();
}

function teamSideSimilarity(selection: string, team: string): number {
  const selectionState = brazilianStateIdentity(selection);
  const teamState = brazilianStateIdentity(team);
  // América-MG e América-RJ, Atlético-GO e Atlético-MG etc. são clubes
  // diferentes. A forma-base sem estado só entra quando não há conflito
  // estadual explícito entre os dois lados comparados.
  if (selectionState && teamState && selectionState !== teamState) return 0;
  return Math.max(
    teamSimilarity(selection, team),
    teamSimilarity(
      expandBrazilianClubSuffix(selection),
      expandBrazilianClubSuffix(team),
    ),
    teamSimilarity(
      stripBrazilianClubSuffix(selection),
      stripBrazilianClubSuffix(team),
    ),
  );
}

export function matchTeamSide(
  selecao: string,
  evento: string,
): "home" | "away" | null {
  const selecaoN = normalizeStr(selecao);
  const teams = splitEventoTeams(evento);

  // Uma alternativa explícita com empate é Dupla Chance, não um único lado.
  // O parser de DC divide as alternativas antes de voltar aqui; callers que
  // pedem diretamente um lado falham fechado em vez de escolher metade.
  if (DRAW_TOKENS.test(selecaoN) && DRAW_ALTERNATIVE.test(selecaoN)) {
    return null;
  }

  // 0) A seleção que é SÓ o token de lado ("Casa", "Home", "Away") não tem nome
  //    de time algum para disputar: ela nomeia o lado do JOGO. Pelo passo 1,
  //    num "Santos vs Casa Pia" o genérico "Casa" viraria o VISITANTE ("Home
  //    United"/"Away FC" em EN). Só a forma EXATA entra aqui: "Casa Pia"
  //    continua sendo o clube, que é o caso que o passo 1 existe para proteger.
  const compactoSemAnotacao = selecaoN
    .replace(PARENTHETICAL_ANNOTATION, "")
    .replace(/\s+/g, " ")
    .trim();
  if (HOME_TOKENS.test(compactoSemAnotacao) && compactoSemAnotacao.split(" ").length === 1) {
    return "home";
  }
  if (AWAY_TOKENS.test(compactoSemAnotacao) && compactoSemAnotacao.split(" ").length === 1) {
    return "away";
  }

  // 1) NOME do time tem prioridade sobre o token. "Casa Pia"/"Home United" são
  //    times reais — casar por similaridade ANTES do token solto evita que o
  //    "casa"/"home"/"away" embutido no nome decida o lado ERRADO (lucro
  //    invertido). Remove a linha p/ comparar só o nome
  //    ("Casa Pia +0.5" → "Casa Pia").
  if (teams) {
    // Primeiro preserva o nome literal inteiro. A remoção genérica de números
    // usada abaixo não pode apagar identificadores reais como `BK 95` ou
    // `Racing 01`; se exatamente um nome aparece na seleção, o lado já está
    // determinado sem interpretar linha alguma.
    const mentions = (team: string) => {
      const normalizedTeam = normalizeStr(team).replace(/\s+/g, " ").trim();
      return normalizedTeam.length > 0 &&
        (` ${selecaoN.replace(/\s+/g, " ").trim()} `).includes(` ${normalizedTeam} `);
    };
    const mentionsHome = mentions(teams.home);
    const mentionsAway = mentions(teams.away);
    const categoryMismatch = (time: string, other: string) => {
      // A total such as "Ben Shelton Under 18" does not select an U18 player.
      // Keep the token when it belongs to the participant's actual name.
      const categorySelection = selecao.replace(/\b(?:over|under|mais|menos|acima|abaixo)\s+(?:de\s+)?\d+(?:[.,]\d+)?/gi,
        token => normalizeStr(time).includes(normalizeStr(token)) ? token : " ");
      if (hasProtectedTeamCategoryConflict(categorySelection, time)) {
        const selectionHasCategory = canonicalizeTeamName(categorySelection).split(" ").some((t) => (
          t === "women" || t === "feminino" || t === "ladies" || t === "fem" ||
          t === "reserves" || t === "reservas" || t === "youth" ||
          /^u\d{2}$/.test(t) || /^sub\d{2}$/.test(t)
        ));
        const bothTeamsShareCategory = !hasProtectedTeamCategoryConflict(time, other);
        if (!selectionHasCategory && bothTeamsShareCategory) {
          return false;
        }
        return true;
      }
      return false;
    };

    if (mentionsHome !== mentionsAway) {
      const time = mentionsHome ? teams.home : teams.away;
      const other = mentionsHome ? teams.away : teams.home;
      return categoryMismatch(time, other) ? null : (mentionsHome ? "home" : "away");
    }

    const selecaoSemLinha = selecao.replace(/[+-]?\d+(?:[.,]\d+)?/g, " ").trim();
    if (selecaoSemLinha) {
      const selecaoTokens = normalizeStr(selecaoSemLinha)
        .split(/\s+/)
        .filter((t) => t.length >= 2 && !GENERIC_TEAM_SUBTOKENS.has(t));
      if (selecaoTokens.length > 0) {
        const homeTokens = new Set(normalizeStr(teams.home).split(/\s+/).filter(Boolean));
        const awayTokens = new Set(normalizeStr(teams.away).split(/\s+/).filter(Boolean));
        const subHome = selecaoTokens.every((t) => homeTokens.has(t));
        const subAway = selecaoTokens.every((t) => awayTokens.has(t));
        if (subHome !== subAway) {
          const time = subHome ? teams.home : teams.away;
          const other = subHome ? teams.away : teams.home;
          if (!categoryMismatch(time, other)) return subHome ? "home" : "away";
        }
      }

      const simHome = teamSideSimilarity(selecaoSemLinha, teams.home);
      const simAway = teamSideSimilarity(selecaoSemLinha, teams.away);
      const best = Math.max(simHome, simAway);
      if (best >= SIDE_MIN_SIMILARITY && Math.abs(simHome - simAway) >= SIDE_MIN_MARGIN) {
        return simHome > simAway ? "home" : "away";
      }
    }
  }

  // 2) Rótulos genéricos completos só entram depois dos nomes reais. Assim,
  //    "Team 1" continua sendo o clube visitante quando o próprio evento usa
  //    esse nome, mas identifica o mandante nos feeds que usam o rótulo ordinal.
  // A anotação final entre parênteses ("Time 1 (+0.5)", "1 (Primeiro Time)")
  // não participa da comparação exata.
  // A seleção pode encadear anotações ("1 (+0.5) (Clube 1)"): todas saem, e
  // NENHUMA pode contradizer o rótulo de fora.
  let semAnotacao = selecaoN;
  let hadParentheticalAnnotation = false;
  const annotationSides: ("home" | "away")[] = [];
  for (;;) {
    const found = semAnotacao.match(PARENTHETICAL_ANNOTATION);
    if (!found || found.index === undefined) break;
    hadParentheticalAnnotation = true;
    const inner = found[0].replace(/^\s*[([]\s*/, "").replace(/\s*[)\]]\s*$/, "");
    if (HOME_LABEL.test(inner)) annotationSides.push("home");
    else if (AWAY_LABEL.test(inner)) annotationSides.push("away");
    semAnotacao = semAnotacao.slice(0, found.index).trim();
  }
  const agreeing = (side: "home" | "away") =>
    annotationSides.every((annotated) => annotated === side) ? side : null;
  const genericLabel = semAnotacao
    .replace(/\s+[+\-]\s*\d+(?:[.,]\d+)?\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  // Dígito nu só vira lado quando a anotação estava isolada entre parênteses:
  // ali o "1" não pode ser confundido com o próprio valor da linha ("1 -0.5"
  // segue ambíguo, e é assim que nomes como "Racing 01" continuam protegidos).
  if (hadParentheticalAnnotation && (genericLabel === "1" || genericLabel === "2")) {
    return agreeing(genericLabel === "1" ? "home" : "away");
  }
  if (HOME_LABEL.test(genericLabel)) return agreeing("home");
  if (AWAY_LABEL.test(genericLabel)) return agreeing("away");

  // 3) Token explícito ("Casa"/"Home"/"Fora"/"Away") — fallback só quando o nome
  //    NÃO resolveu (seleção genérica de lado, sem nome de time).
  if (HOME_TOKENS.test(selecaoN) && !AWAY_TOKENS.test(selecaoN)) return "home";
  if (AWAY_TOKENS.test(selecaoN) && !HOME_TOKENS.test(selecaoN)) return "away";

  return null;
}

/**
 * Seleção de moneyline em uma única fonte para settlement e providers.
 * Feeds 1X2 usam os tokens compactos 1/X/2; nomes de time continuam tendo
 * prioridade sobre "draw"/"empate" para não confundir clubes com esses termos.
 */
export function matchMoneylineSelection(
  selecao: string,
  evento: string,
  options: MoneylineReading = {},
): "home" | "away" | "draw" | null {
  const compact = normalizeStr(selecao).replace(/\s+/g, " ").trim();
  if (compact === "x") return "draw";
  if (compact === "1") return "home";
  if (compact === "2") return "away";

  // Tolera apenas rótulos conhecidos e o sufixo FT. Não procura qualquer dígito
  // solto: números de nomes continuam ambíguos. O escopo dos rótulos PT vem do
  // MESMO dado dos rótulos de lado (`SIDE_SCOPE_NOUNS`).
  //
  // Os rótulos se dividem por uma propriedade, não por idioma: "jogo N" e
  // "game N" JÁ significam unidade parcial no resto do sistema
  // (`marketPeriodOf` devolve OTHER, `marketMapNumberOf` só os aceita como mapa
  // em eSports), então "Vencedor do Jogo 1" é indistinguível de "vencedor do
  // mapa 1" e resolver `home` liquidaria a aposta pelo placar da partida
  // inteira. Esses rótulos EXIGEM separador explícito: em
  // "Game Winner - 1" o traço é a procedência de que o número é o LADO; sem
  // ele, falha fechado e vai para settlement manual. `partida`/`evento`/`luta`
  // e `match`/`event` não são unidades numeradas e seguem sem exigir separador.
  const plainLabels = String.raw`resultado final|resultado do jogo|resultado da partida|(?:vencedor|ganhador)(?: d[oa] (?:${SIDE_SCOPE}))?|(?:event|match)\s+winner|money\s*line`;
  const unitLabels = String.raw`(?:vencedor|ganhador) d[oa] jogo|game\s+winner`;
  const labeled = compact.match(
    new RegExp(
      String.raw`^(?:(?:${plainLabels})\s*[:\-]?\s*|(?:${unitLabels})\s*[:\-]\s*)?([12x])(?:\s*(?:\((?:ft|full time|tr|tempo regulamentar|regulamentar)\)|-\s*(?:ft|full time|tr|tempo regulamentar|regulamentar)))?$`,
    ),
  );
  if (labeled?.[1] === "1") return "home";
  if (labeled?.[1] === "2") return "away";
  if (labeled?.[1] === "x") return "draw";

  // A palavra "empate" descreve a regra do DNB nestas expressões; não é uma
  // seleção no empate de 1X2.
  if (DNB_ANY.test(compact)) {
    return null;
  }

  if (moneylineSelectionAsksAnotherMarket(selecao, evento)) return null;
  const side = matchTeamSide(selecao, evento);
  // `matchTeamSide` aceita o nome DENTRO de uma frase. Numa moneyline o resto
  // da frase pode inverter a aposta ("Palmeiras não perde", "Contra
  // Flamengo"): aí não há lado — nem o empate abaixo.
  if (side) return moneylineRemainderFits(selecao, evento, side, options) ? side : null;
  // O fallback abaixo lê a PALAVRA "empate" como se fosse a aposta no empate.
  // Duas famílias de seleção contêm essa palavra sem serem isso, e as duas
  // sairiam com dinheiro invertido:
  //   "Home or Draw" / "Flamengo ou Empate" → Dupla Chance: casa 2-0 daria LOST
  //   "No Draw" / "Sem empate"              → anti-empate: 0-0 daria WON
  // Recusa em vez de escolher: "no empate" em PT significa o CONTRÁRIO de
  // "no draw" em EN, e adivinhar a língua para decidir lado é a aposta que
  // este arquivo não faz. Fail-closed custa liquidação manual; errar custa o
  // valor da aposta.
  if (DRAW_TOKENS.test(compact) && (DRAW_ALTERNATIVE.test(compact) || DRAW_NEGATED.test(compact))) {
    return null;
  }
  return DRAW_TOKENS.test(compact) ? "draw" : null;
}

/**
 * Como ler o resto da seleção de moneyline além do nome do time.
 *
 * - padrão (liquidação, CLV, canonicalização): recusa só o complemento que
 *   muda a aposta ("não perde", "contra", "e ambas marcam") ou um pedaço do
 *   outro time. O nome gravado pode ser mais longo ou mais curto que o do
 *   evento ("Flamengo RJ", "Vasco", "Borussia Dortmund", "Alcaraz Garfia C.").
 * - `strict` (leitor por regra): só o nome e palavras de "vence"; o resto vai
 *   para a leitura por IA, que custa menos que uma aposta errada.
 */
export type MoneylineReading = { strict?: boolean };

/** Palavras que só dizem "este time vence" (e o período, que o mercado confere à parte). */
const MONEYLINE_DECORATION = new Set([
  "ml", "moneyline", "money", "line", "1x2", "vence", "vencer", "vencedor", "vitoria", "ganha", "ganhar",
  "win", "wins", "winner", "to", "para", "pra", "p", "o", "a", "resultado", "final", "match", "jogo", "partida",
  "ft", "tr", "full", "time", "regulamentar", "tempo",
  // Rótulos de lado sem nome ("Casa", "Time 1", "Away"): o lado vem deles.
  "home", "casa", "mandante", "away", "fora", "visitante", "team", "equipe", "clube", "club", "local",
  "visitor", "visiting", "primeiro", "primeira", "segundo", "segunda", "first", "second", "1st", "2nd", "1o", "2o",
  "ganhador", "evento", "confronto", "encontro", "duelo", "combate", "luta", "serie",
  // Escopo que inclui a prorrogação ou limita aos 90 minutos: quem confere é o período do mercado.
  "incl", "inc", "including", "incluindo", "ot", "overtime", "prorrogacao", "90", "min", "minutos",
  // Sufixo estadual do clube ("Flamengo RJ", "Atlético MG").
  ...Object.keys(BRAZILIAN_STATE_SUFFIXES).map((state) => state.toLowerCase()),
]);
/** O número só é o lado ao lado de um rótulo: "Time 1", "Vencedor 2". */
const MONEYLINE_SIDE_LABEL = new Set(["time", "team", "equipe", "clube", "club", "vencedor", "ganhador", "winner"]);
const MONEYLINE_PERIOD = /\b(?:[12]\s*[oº°ª]?\s*(?:tempo|etapa|parte)|(?:primeir[oa]|segund[oa])\s+(?:tempo|etapa|parte)|[12](?:st|nd)\s+half|(?:first|second)\s+half|half\s*time|intervalo|1t|2t|h1|h2|1h|2h)\b/g;
/** Sobra que inverte ou combina a aposta, mesmo parecida com um pedaço de nome. */
const MONEYLINE_COMPLEMENT = new Set([
  "nao", "not", "perde", "perder", "empata", "empatar", "empate", "draw", "contra", "against", "sem",
  "marca", "marcam", "marcar", "gol", "gols", "ambas", "ambos", "btts", "e", "and", "ou", "or", "mais", "menos",
  "over", "under", "handicap", "virada", "sofrer", "x", "vs", "dupla", "chance", "anula", "dnb",
  // A parte do jogo ("pistol round") e o método da vitória ("por KO") não são o vencedor do jogo.
  "pistol", "round", "rounds", "ko", "tko", "nocaute", "finalizacao", "submissao", "decisao", "metodo",
]);

/** Categoria do time ("Sub-20", "U 23"): o número não é linha nem placar. */
const TEAM_CATEGORY = /\b(?:sub|under|u)\s*-?\s*\d{2}\b/g;
/** Passar de fase, levar o título ou não sofrer gol: o vencedor do jogo não responde. */
const MONEYLINE_OTHER_OUTCOME =
  /\b(?:classific\w*|qualif\w*|avanca\w*|advances?|passar?|campea?o?|titulo)\b|\ba zero\b|\bto nil\b|\bclean sheet\b|\bsem sofrer\b/;

/**
 * A seleção de moneyline pede outro mercado: traz linha ("Flamengo -1.5",
 * "Flamengo +0.5"), placar exato ("Flamengo 2x0") ou classificação, título e
 * vitória a zero. Lida só pelo nome, pagaria a vitória simples. Com o evento,
 * os números do nome do clube (Mainz 05, 1. FC Köln) saem antes.
 */
export function moneylineSelectionAsksAnotherMarket(selecao: string, evento?: string): boolean {
  const cleaned = normalizeStr(selecao)
    .replace(/[−–—]/g, "-")
    .replace(TEAM_CATEGORY, " ")
    .replace(MONEYLINE_PERIOD, " ")
    .replace(/\b1\s*x\s*2\b/g, " ");
  const text = evento ? stripTeamNames(cleaned, evento) : cleaned;
  return /(?:^|[\s([])[+-]\d/.test(text)
    || /\d[.,]\d/.test(text)
    || /\b\d+\s*(?:[x:]|\s-\s|-)\s*\d+\b/.test(text)
    || MONEYLINE_OTHER_OUTCOME.test(text);
}

function nameTokens(team: string): string[] {
  return [team, canonicalizeTeamName(team), expandBrazilianClubSuffix(team)]
    .flatMap((form) => normalizeStr(form).split(/[^a-z0-9]+/))
    .filter(Boolean);
}

function moneylineRemainderFits(
  selecao: string,
  evento: string,
  side: "home" | "away",
  options: MoneylineReading,
): boolean {
  const teams = splitEventoTeams(evento);
  if (!teams) return false;
  const own = nameTokens(side === "home" ? teams.home : teams.away);
  const ownSet = new Set(own);
  const otherSet = new Set(nameTokens(side === "home" ? teams.away : teams.home));
  const tokens = canonicalizeTeamName(normalizeStr(selecao).replace(MONEYLINE_PERIOD, " "))
    .split(" ")
    .filter(Boolean);
  const sideDigit = side === "home" ? "1" : "2";
  // O número só é o lado como marca à parte ("(1) Flamengo", "1 - Flamengo") ou com rótulo ("Time 1").
  const raw = normalizeStr(selecao);
  const digitMarksSide = /^\s*[12]\s*[-:.)]|\(\s*[12]\s*\)|\[\s*[12]\s*\]/.test(raw)
    || tokens.some((token) => MONEYLINE_SIDE_LABEL.has(token));
  // Abreviação do nome ("Man Utd"): a sobra é prefixo de uma palavra do nome, ou o contrário.
  const partOfName = (token: string) => own.some((name) =>
    (token.length >= 3 && name.startsWith(token)) || (name.length >= 3 && token.startsWith(name)));
  return tokens.every((token) => {
    if (ownSet.has(token)) return true;
    if (MONEYLINE_COMPLEMENT.has(token)) return false;
    // O número do lado, se for o mesmo lado.
    if (/^[12]$/.test(token)) {
      return digitMarksSide
        && (token === sideDigit || (options.strict === true && tokens.some((other) => MONEYLINE_SIDE_LABEL.has(other))));
    }
    if (MONEYLINE_DECORATION.has(token) || GENERIC_TEAM_SUBTOKENS.has(token)) return true;
    if (otherSet.has(token)) return false;
    return options.strict !== true || (!/\d/.test(token) && partOfName(token));
  });
}

/**
 * Lado da aposta quando ele pode vir de DUAS fontes: o rótulo do mercado
 * ("Home Total Goals", "Away Asian Handicap") e o nome do time na seleção.
 *
 * Uma função só para team total, handicap, total e handicap de estatística:
 * cópias do guard divergem e liquidam no lado errado. Regra única:
 *
 *  - as duas fontes discordam → ninguém decide, é decisão humana;
 *  - só uma fala → ela decide;
 *  - nenhuma fala → `null`, e o caller escolhe o que fazer.
 */
export function resolveSideFromMarketAndSelection(
  mercado: string,
  selecao: string,
  evento: string,
): { side: "home" | "away" | null; contradicts: boolean } {
  const doMercado = matchTeamSide(mercado, evento);
  const daSelecao = matchTeamSide(selecao, evento);
  if (doMercado && daSelecao && doMercado !== daSelecao) {
    return { side: null, contradicts: true };
  }
  return { side: daSelecao ?? doMercado, contradicts: false };
}

/** Seleção de Draw No Bet: sempre um lado; empate puro é inválido. */
export function matchDrawNoBetSelection(
  selecao: string,
  evento: string,
): "home" | "away" | null {
  let compact = normalizeStr(selecao).replace(/\s+/g, " ").trim();
  compact = compact.replace(DNB_PREFIX, "").replace(DNB_SUFFIX, "").trim();
  if (compact === "1") return "home";
  if (compact === "2") return "away";
  if (!compact || compact === "x" || DRAW_TOKENS.test(compact)) return null;
  return matchTeamSide(compact, evento);
}

export type DoubleChanceOutcome = "home" | "away" | "draw";

function doubleChancePartOutcome(
  part: string,
  evento: string,
): DoubleChanceOutcome | null {
  const normalized = normalizeStr(part).replace(/\s+/g, " ").trim();
  if (normalized === "1") return "home";
  if (normalized === "2") return "away";
  if (/^(?:x|empate|draw)$/.test(normalized)) return "draw";

  const side = matchTeamSide(part, evento);
  const hasDraw = DRAW_TOKENS.test(normalized) || /\bx\b/.test(normalized);
  // Um pedaço que declara lado E empate ao mesmo tempo não é uma alternativa
  // atômica (ex.: "Fora X"). Falha fechado em vez de escolher metade dele.
  if (side && hasDraw) return null;
  if (side) return side;
  return hasDraw ? "draw" : null;
}

/**
 * As duas saídas cobertas por uma seleção de Dupla Chance. É a mesma fonte
 * usada por settlement e pela equivalência sharp, evitando que uma grafia seja
 * precificável mas não liquidável (ou o inverso).
 */
export function matchDoubleChanceSelection(
  selecao: string,
  evento: string,
): readonly [DoubleChanceOutcome, DoubleChanceOutcome] | null {
  const normalized = normalizeStr(selecao)
    .replace(/\s+/g, " ")
    .trim()
    .replace(new RegExp(String.raw`^${DOUBLE_CHANCE_LABEL}\s*[:\-]?\s*`), "")
    .replace(
      new RegExp(
        String.raw`\s*(?:\(\s*${DOUBLE_CHANCE_LABEL}\s*\)|-\s*${DOUBLE_CHANCE_LABEL}|${DOUBLE_CHANCE_LABEL})\s*$`,
      ),
      "",
    )
    .trim();
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  if (compact === "1x" || compact === "x1") return ["home", "draw"];
  if (compact === "x2" || compact === "2x") return ["draw", "away"];
  if (compact === "12" || compact === "21") return ["home", "away"];

  // "Time +1" declara handicap, não a dupla time/casa. Preserva os
  // compactos explícitos "1 + 2", mas não escolhe o número como segundo lado.
  if (/\+\s*\d|(?:^|\s)[−–-]\s*\d/.test(normalized) && !/^[12x]\s*\+\s*[12x]$/.test(normalized)) return null;

  const conjunction =
    normalized.match(/^(.+?)\s+(?:e|y|and|&)\s+(.+)$/) ??
    normalized.match(/^(.+?)\s*,\s*(.+)$/);
  if (conjunction) {
    // `e` também aparece dentro de nomes. Só o reconhece quando ao menos uma
    // alternativa é um token inequívoco de outcome (Casa/Empate/1/X/2...).
    const explicitOutcome = /^(?:1|2|x|home|away|casa|fora|mandante|visitante|draw|empate)$/;
    if (!conjunction.slice(1).some((part) => explicitOutcome.test(normalizeStr(part ?? "").trim()))) {
      return null;
    }
  }

  const parts = normalized
    .split(DC_SPLIT)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length !== 2) return null;
  const outcomes = parts.map((part) => doubleChancePartOutcome(part, evento));
  if (outcomes.some((outcome) => outcome === null)) return null;
  const unique = new Set(outcomes as DoubleChanceOutcome[]);
  if (unique.size !== 2) return null;
  if (unique.has("home") && unique.has("draw")) return ["home", "draw"];
  if (unique.has("draw") && unique.has("away")) return ["draw", "away"];
  if (unique.has("home") && unique.has("away")) return ["home", "away"];
  return null;
}
