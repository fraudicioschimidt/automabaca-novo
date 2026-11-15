import type { SportEntry } from "./types";

export const SPORTS_REGISTRY = [
  {
    canonical: "Soccer",
    labelPt: "Futebol",
    aliases: ["futebol", "futbol"],
    emojis: ["⚽"],
    texto:
      /\b(?:futebol(?! americano| australiano| de praia)|soccer|association football)\b|\b(?:escanteios?|corners?|cartoes|cartao|bookings?|both teams cards?|total cards?|yellow cards?|red cards?|chutes a gol|tiros? de meta|goal kicks?|impedimentos?|offsides?)\b/,
    // "Serie A", "La Liga" e "Champions League" também nomeiam ligas de
    // basquete, vôlei, handebol e futsal ("Lega Basket Serie A", "La Liga
    // Endesa", "EHF/FIBA/CEV Champions League"): com a palavra de outra
    // modalidade no texto, não confirmam futebol. Se o texto também traz outra
    // modalidade, `detectSportFromText` aplica a guarda linha a linha, porque
    // a outra linha pode ser de outro jogo do post. "Indian/Caribbean/Lanka
    // Premier League" são do Cricket, e "PDC Premier League", dos dardos;
    // "Bangladesh Premier League" nomeou as ligas de futebol (até 2025) e de
    // críquete, e não prova nenhuma das duas.
    competicoes:
      /\b(?:(?<!\b(?:indian|caribbean|bangladesh|lanka|pdc)\s+)premier league|(?<!\b(?:ehf|fiba|cev)\b[\s\S]*)champions league(?![\s\S]*\b(?:volei|voleibol|volleyball|basquete|basquetebol|baloncesto|basketball|futsal|handebol|handball|ehf|fiba|cev)\b)|europa league|conference league|libertadores|sudamericana|brasileirao|copa do brasil|(?<!\b(?:basket|basquete|basquetebol|baloncesto|basketball|volei|voleibol|volley|volleyball|futsal|handebol|handball|fiba|cev)\b[\s\S]*)(?:serie [abcd]|la liga(?! endesa))(?![\s\S]*\b(?:basket|basquete|basquetebol|baloncesto|basketball|volei|voleibol|volley|volleyball|futsal|handebol|handball|endesa|fiba|cev)\b)|bundesliga|ligue 1|eredivisie|primeira liga|liga portugal|efl championship|england championship|mls|usl)\b/,
    flashscoreId: 1,
    unidadeDoPlacar: "gols",
  },
  {
    canonical: "Basketball",
    labelPt: "Basquete",
    aliases: ["basquete", "basquetebol", "baloncesto", "basket"],
    emojis: ["🏀"],
    texto:
      /\b(?:basquete|basquetebol|baloncesto|basketball|basket)\b|\b(?:rebotes?|rebounds?|cestas?(?: de (?:3|tres))?|arremessos? de (?:3|tres)|three pointers?|triplos? convertidos?|triplas? convertidas?|triplo[- ]duplo|triple[- ]double|duplo[- ]duplo|double[- ]double|tocos?|roubos de bola)\b/,
    competicoes: /\b(?:nba|wnba|nbb|euroleague|fiba|liga acb|liga endesa|lega basket|lnb chile|ncaa basketball)\b/,
    flashscoreId: 3,
    unidadeDoPlacar: "pontos",
  },
  {
    canonical: "Tennis",
    labelPt: "Tênis",
    aliases: ["tenis"],
    emojis: ["🎾"],
    texto: /\b(?:tenis|tennis)\b|\b(?:tie breaks?|tiebreak|duplas faltas?|double faults?)\b/,
    competicoes: /\b(?:atp|wta|itf|challenger)\b/,
    flashscoreId: 2,
    unidadeDoPlacar: "games",
  },
  {
    canonical: "Volleyball",
    labelPt: "Vôlei",
    aliases: ["volei", "voleibol"],
    emojis: ["🏐"],
    texto: /\b(?:volei|voleibol|volleyball)\b/,
    competicoes: /\b(?:cev|superliga de volei|volleyball nations league)\b/,
    flashscoreId: 12,
    unidadeDoPlacar: "sets",
  },
  {
    canonical: "Hockey",
    labelPt: "Hóquei",
    aliases: ["hoquei", "ice hockey", "hoquei no gelo"],
    emojis: ["🏒"],
    texto: /\b(?:hockey|hoquei)\b/,
    competicoes: /\b(?:nhl|khl)\b/,
    flashscoreId: 4,
    unidadeDoPlacar: "gols",
  },
  {
    canonical: "Baseball",
    labelPt: "Beisebol",
    aliases: ["beisebol"],
    emojis: ["⚾"],
    texto: /\b(?:baseball|beisebol)\b|\b(?:home runs?|strikeouts?|bases totais?|total bases?)\b/,
    competicoes: /\b(?:mlb|npb|kbo)\b/,
    flashscoreId: 6,
    unidadeDoPlacar: "corridas",
  },
  {
    canonical: "American Football",
    labelPt: "Futebol americano",
    aliases: ["futebol americano", "nfl"],
    emojis: ["🏈"],
    texto: /\b(?:american football|futebol americano)\b|\b(?:touchdowns?|passing yards?|rushing yards?|receiving yards?|jardas de passe|jardas terrestres)\b/,
    competicoes: /\b(?:nfl|ncaa football|super bowl)\b/,
    flashscoreId: 5,
    unidadeDoPlacar: "pontos",
  },
  {
    canonical: "eSports",
    labelPt: "eSports",
    aliases: ["e sports"],
    emojis: ["🎮"],
    // Estatística de combate + mapa numerado é terminologia explícita de
    // eSports; "kills" isolado não basta para confirmar uma modalidade.
    texto: /\b(?:esports?|e sports?)\b|\b(?:kills?|deaths?|abates?|mortes?)\b[^\n]*\bmapa?\s*[1-5]\b|\bmapa?\s*[1-5]\b[^\n]*\b(?:kills?|deaths?|abates?|mortes?)\b/,
    competicoes:
      /\b(?:vct|counter strike|cs2|cs go|valorant|league of legends|dota 2)\b/,
    flashscoreId: 36,
    unidadeDoPlacar: "mapas",
  },

  // ─────────────────── Modalidades de catálogo ───────────────────
  // Entram porque têm caminho real: o FlashScore liquida (`modo: inferido`),
  // algum provider de odds cobre em `providers/coverage.ts`, ou os dois.
  //
  // Handebol, futsal, dardos, snooker, tênis de mesa e vôlei de praia têm a
  // continua exclusivamente no fluxo FlashScore/manual conforme o perfil.
  {
    canonical: "Handball",
    labelPt: "Handebol",
    aliases: ["handebol"],
    emojis: ["🤾"],
    texto: /\b(?:handebol|handball)\b/,
    competicoes: /\b(?:ehf|liga asobal)\b/,
    flashscoreId: 7,
    unidadeDoPlacar: "gols",
  },
  {
    // Preserve the existing Union canonical; League has its own provider IDs.
    canonical: "Rugby",
    labelPt: "Rúgbi",
    aliases: ["rugbi", "rugby union"],
    emojis: [],
    texto: /\b(?:rugby|rugbi)(?!\s+league)\b/,
    competicoes: /\b(?:six nations|super rugby|united rugby championship)\b/,
    flashscoreId: 8,
    unidadeDoPlacar: "pontos",
  },
  {
    canonical: "Rugby League", labelPt: "Rugby League", aliases: ["rugbi league"],
    emojis: [], texto: /\b(?:rugby|rugbi) league\b/, competicoes: /\bnrl\b/,
    flashscoreId: 19, unidadeDoPlacar: "pontos",
  },
  {
    canonical: "Cricket",
    labelPt: "Críquete",
    aliases: ["criquete"],
    emojis: ["🏏"],
    texto: /\b(?:cricket|criquete)\b/,
    competicoes: /\b(?:ipl|indian premier league|caribbean premier league|lanka premier league|big bash|the hundred|t20 blast)\b/,
    flashscoreId: 13,
    unidadeDoPlacar: "corridas",
  },
  {
    // O FlashScore devolve `("TKO/2","TKO/2")` — método e round em string, igual
    // dos dois lados —, então luta NUNCA liquida por placar (`modo: nenhum`).
    canonical: "MMA",
    labelPt: "MMA",
    aliases: ["artes marciais mistas", "mixed martial arts"],
    emojis: [],
    texto: /\b(?:mma|artes marciais mistas)\b/,
    competicoes: /\b(?:ufc|bellator|one championship|pfl)\b/,
    flashscoreId: 28,
    unidadeDoPlacar: "outra",
  },
  {
    canonical: "Boxing",
    labelPt: "Boxe",
    aliases: ["boxe"],
    emojis: [],
    texto: /\b(?:boxe|boxing)\b/,
    competicoes: null,
    flashscoreId: 16,
    unidadeDoPlacar: "outra",
  },
  {
    // Sem medição do FlashScore (não teve jogo na janela da sonda), então o id
    canonical: "Golf",
    labelPt: "Golfe",
    aliases: ["golfe"],
    emojis: ["⛳"],
    texto: /\b(?:golfe?)\b/,
    competicoes: /\b(?:pga|lpga|dp world tour|ryder cup)\b/,
    flashscoreId: 23,
    unidadeDoPlacar: "outra",
  },
  {
    canonical: "Futsal",
    labelPt: "Futsal",
    aliases: [],
    emojis: [],
    texto: /\bfutsal\b/,
    competicoes: null,
    flashscoreId: 11,
    unidadeDoPlacar: "gols",
  },
  {
    // Sem emoji: 🎯 é usado como "alvo/meta" em post de tipster de qualquer
    // esporte, e emoji vale 95 de confiança — auto-confirmaria dardos em cima
    // de uma figura de linguagem.
    canonical: "Darts",
    labelPt: "Dardos",
    aliases: ["dardos"],
    emojis: [],
    texto: /\b(?:darts?|dardos)\b/,
    competicoes: /\b(?:pdc|world darts)\b/,
    flashscoreId: 14,
    unidadeDoPlacar: "legs",
  },
  {
    // 🎱 fica de fora pelo mesmo motivo de 🎯: é bola oito/sinuca genérica.
    canonical: "Snooker",
    labelPt: "Snooker",
    aliases: ["sinuca"],
    emojis: [],
    texto: /\b(?:snooker|sinuca)\b/,
    competicoes: /\bworld snooker\b/,
    flashscoreId: 15,
    unidadeDoPlacar: "frames",
  },
  {
    canonical: "Table Tennis",
    labelPt: "Tênis de mesa",
    aliases: ["tenis de mesa", "ping pong"],
    emojis: ["🏓"],
    texto: /\b(?:table tennis|tenis de mesa|ping pong)\b/,
    competicoes: /\b(?:wtt|ittf)\b/,
    flashscoreId: 25,
    unidadeDoPlacar: "sets",
  },
  {
    // Sem emoji próprio: 🏐 já é do vôlei de quadra.
    canonical: "Beach Volleyball",
    labelPt: "Vôlei de praia",
    aliases: ["volei de praia"],
    emojis: [],
    texto: /\b(?:beach volleyball|volei de praia)\b/,
    competicoes: null,
    flashscoreId: 17,
    unidadeDoPlacar: "sets",
  },
  // Pinnacle17 sport IDs are verified against /sport/list. FlashScore keeps
  // its existing measured profiles; adding identity never enables settlement.
  {
    canonical: "Badminton", labelPt: "Badminton", aliases: [], emojis: [],
    texto: /\bbadminton\b/, competicoes: null, flashscoreId: 21, unidadeDoPlacar: "sets",
  },
  {
    canonical: "Water Polo", labelPt: "Polo aquático", aliases: ["polo aquatico"], emojis: [],
    texto: /\b(?:water polo|polo aquatico)\b/, competicoes: null, flashscoreId: 22, unidadeDoPlacar: "gols",
  },
  {
    canonical: "Aussie Rules", labelPt: "Futebol australiano", aliases: ["futebol australiano", "australian rules football", "australian football"], emojis: [],
    texto: /\b(?:aussie rules|futebol australiano|australian rules(?: football)?|australian football)\b/, competicoes: null, flashscoreId: 18, unidadeDoPlacar: "pontos",
  },
  {
    canonical: "Cycling", labelPt: "Ciclismo", aliases: ["ciclismo"], emojis: [],
    texto: /\b(?:cycling|ciclismo)\b/, competicoes: null, flashscoreId: 34, unidadeDoPlacar: "outra",
  },
  {
    canonical: "Formula 1", labelPt: "Fórmula 1", aliases: ["f1", "formula um"], emojis: [],
    texto: /\b(?:formula 1|f1|formula um)\b/, competicoes: null, flashscoreId: null, unidadeDoPlacar: "outra",
  },
] as const satisfies readonly SportEntry[];
