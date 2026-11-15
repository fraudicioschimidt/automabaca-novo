import { normalizeStr } from "@/src/domain/text";

const CANONICAL_BOOKMAKERS: Record<string, string> = {
  "1xbet": "1xBet",
  bet365: "Bet365",
  betano: "Betano",
  betfair: "Betfair",
  betnacional: "Betnacional",
  estrelabet: "EstrelaBet",
  esportesdasorte: "Esportes da Sorte",
  bwin: "Bwin",
  kto: "KTO",
  novibet: "Novibet",
  parimatch: "Parimatch",
  pinnacle: "Pinnacle",
  pixbet: "Pixbet",
  sportingbet: "Sportingbet",
  stake: "Stake",
  superbet: "Superbet",
  rivalo: "Rivalo",
  vaidebet: "VaideBet",
};

/** A palavra (sem acento nem pontuação) é uma casa conhecida ("betano", "bet365"). */
export function isKnownBookmakerKey(key: string): boolean {
  return Object.hasOwn(CANONICAL_BOOKMAKERS, key);
}

/** Normaliza somente marcas conhecidas; nomes desconhecidos preservam a grafia. */
export function canonicalizeBookmakerName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const keyOf = (name: string) => normalizeStr(name).replace(/[^a-z0-9]/g, "");
  const direct = CANONICAL_BOOKMAKERS[keyOf(trimmed)];
  if (direct) return direct;
  // Sufixo de plano, nível ou canal não cria outra marca. O teste é ESTRUTURAL,
  // não uma lista de palavras: enumerar adjetivos (Oficial, VIP, Pro, Premium,
  // Gold…) não converge. O prefixo de palavras precisa ser uma marca
  // conhecida — casa desconhecida continua preservada por inteiro.
  // O ponto separa palavras como o espaço: "Stake.bet" e "Betano.com" são a
  // marca com o domínio colado.
  const words = trimmed.split(/[\s.]+/).filter(Boolean);
  for (let take = words.length - 1; take >= 1; take -= 1) {
    const brand = CANONICAL_BOOKMAKERS[keyOf(words.slice(0, take).join(" "))];
    if (brand) return brand;
  }
  // Grafia colada ("Betano-VIP", "BetanoPro") não tem fronteira de palavra:
  // ali só a lista de sufixos operacionais conhecidos resolve. A remoção é UMA
  // por vez, testando a marca a cada passo: com `+` guloso "pixbetbet" perdia
  // os dois "bet" de uma vez e sobrava "pix".
  // `official` (EN) além de `oficial` (PT); `live`/`tv`/`casino` são CANAIS da
  // mesma casa, não outra marca. A segurança continua vindo da estrutura: só
  // remove se o que sobra é marca do catálogo.
  const GLUED_SUFFIX =
    /(?:sportsbook|international|esportes|apostas|exchange|official|sports|online|oficial|premium|casino|express|mobile|global|clube|prime|club|live|lite|plus|pro|vip|app|bet|tv|brasil|br)$/;
  let key = keyOf(trimmed);
  for (let step = 0; step < 4; step += 1) {
    const stripped = key.replace(GLUED_SUFFIX, "");
    if (stripped === key || !stripped) break;
    key = stripped;
    const brand = CANONICAL_BOOKMAKERS[key];
    if (brand) return brand;
  }
  return trimmed;
}
