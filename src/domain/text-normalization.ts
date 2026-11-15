/**
 * Normalização de texto para MATCHING (nunca para exibição) e o vocabulário
 * de tokens de nome de time. É a base de `text.ts` e `team-category.ts`, que
 * dependem daqui e nunca o contrário.
 */

export function normalizeStr(s: string): string {
  return (s || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

export const TEAM_STOP_WORDS = new Set([
  "el", "la", "los", "las", "le", "les", "de", "do", "da", "dos", "das",
  "fc", "cf", "sc", "ac", "as", "sd", "ud", "cd", "rc", "rcd", "cr", "se", "ec", "ca", "ad",
  "fk", "sk", "bk", "if", "ik", "gk", "sf", "afc", "bfc", "cfc", "vfc", "ks", "mks", "gks", "lks", "zks", "ksp", "tsv", "fsv", "vfb", "vfl", "spvgg",
  "real", "club", "clube", "team", "equipe", "sporting", "atletico",
]);

// Expansões token-inteiro → forma canônica. Curado e conservador (altíssima
// confiança no domínio); o gate de similaridade é a rede extra.
const TOKEN_SYNONYMS: Record<string, string> = {
  utd: "united",
  st: "saint",
  ste: "sainte",
  dep: "deportivo",
  depor: "deportivo",
  atl: "atletico",
  atm: "atletico",
  ath: "athletic",
  intl: "international",
  cd: "deportivo",
  univ: "universidad",
  spfc: "sao paulo",
  women: "women",
  woman: "women",
  fem: "women",
  feminino: "women",
  feminina: "women",
  fminino: "women",
  femenino: "women",
  femenina: "women",
  // As grafias locais do time feminino viram `women`: separam do masculino e
  // aproximam "Arsenal Ladies" de "Arsenal Women".
  ladies: "women",
  lady: "women",
  girls: "women",
  femminile: "women",
  femminili: "women",
  femenil: "women",
  damen: "women",
  dames: "women",
  feminines: "women",
  feminine: "women",
};

// Tokens que distinguem times DIFERENTES (feminino ≠ masculino, sub-20 ≠
// profissional, B ≠ principal) — nunca removidos nem expandidos.
const PROTECTED_TOKENS = new Set([
  "women", "woman", "fem", "feminino", "feminina", "fminino", "femenino", "femenina",
  // `w` é como o FlashScore escreve o time feminino ("Lyon W (Fra)").
  "w",
  "u15", "u16", "u17", "u18", "u19", "u20", "u21", "u23",
  "sub15", "sub17", "sub19", "sub20", "sub21", "sub23",
  "b", "ii", "iii", "reserve", "reserves", "reserva", "reservas", "youth", "academy",
  // "academy" em finlandês e em húngaro/polonês: `KuPS Akatemia` é time de
  // base; `Puskas Akademia` é o nome do clube, e com as duas grafias na mesma
  // classe o "Puskas Academy" do tipster casa com ele.
  "akatemia",
  "akademia",
  "amateur", "amateure",
  // O time reserva holandês ("Jong Ajax", "Jong PSV") joga a Eerste Divisie.
  "jong",
]);

/**
 * Reservas / II / Youth / U21–U23 — mesma "classe" em feeds (Pinnacle vs
 * tipster): "Adelaide United II" ↔ "Adelaide United U23". O "b" solto
 * (Barcelona B) fica fora: em várias ligas o time B ≠ U23. U15–U20 também
 * (base distinta).
 */
export const RESERVE_CLASS_TOKENS = new Set([
  "ii", "iii", "reserve", "reserves", "reserva", "reservas", "youth", "academy",
  "akatemia", "akademia",
  "amateur", "amateure", "u21", "u23", "sub21", "sub23",
  "jong",
]);
export const RESERVE_CLASS_MARKER = "reserve_class";

export function isProtectedToken(token: string): boolean {
  if (PROTECTED_TOKENS.has(token)) return true;
  if (/^u\d{2}$/.test(token)) return true;
  if (/^sub\d{2}$/.test(token)) return true;
  return false;
}

/**
 * Times reserva cujo nome não usa o vocabulário da categoria: o time B
 * espanhol com nome próprio e o sub-23 italiano. Ganham o token que a
 * categoria já entende, e a palavra própria fica: "Castilla" sozinho continua
 * casando o Real Madrid Castilla, e o Real Madrid principal não. Só a forma que
 * é reserva: "Fortuna Düsseldorf" e "Futuro Kings" são times principais.
 */
const RESERVE_TEAM_NAMES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bcastilla\b(?! b\b)/, "castilla b"],
  [/\bcelta (?:vigo )?fortuna\b(?! b\b)/, "celta vigo fortuna b"],
  [/^bilbao athletic\b(?! b\b)/, "bilbao athletic b"],
  // O reserva do Club Brugge na Challenger Pro League ("Club Brugge II" no
  // dicionário); o nome próprio fica para a busca por texto.
  [/\bclub nxt\b(?! ii\b)/, "club nxt ii"],
  [/\bnext ?gen(?:eration)?\b(?! u23\b)/, "$& u23"],
  [/\b(?:ac )?milan futuro\b(?! u23\b)/, "ac milan futuro u23"],
];

/**
 * Canonicaliza um nome de time para matching: acentos fora, separadores viram
 * espaço e abreviações expandidas, preservando tokens protegidos e números que
 * podem fazer parte da identidade ("Racing 01" ≠ "Racing 02"). Números de
 * fundação continuam compatíveis pelo score de containment, sem serem apagados.
 */
export function canonicalizeTeamName(s: string): string {
  // "(Am)" é como o FlashScore escreve o time amador/reserva ("Austria Vienna
  // (Am)" joga a 2. Liga). Só com essa grafia: "(AM)" é o estado do Amazonas.
  const base = normalizeStr((s || "").replace(/\(Am\)/g, " amateur "))
    .replace(/[-_./·•|]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // Feeds lusófonos usam "Sub-20"/"Sub 20" onde providers usam U20.
    // A categoria continua protegida; apenas ganha uma grafia única.
    .replace(/\b(sub|under|u)\s*(\d{2})s?\b(?!\s*\d)/g, "u$2");
  if (!base) return "";

  const tokens = base.split(" ").filter(Boolean);
  const expanded = tokens.map((t, index) => {
    const synonym = TOKEN_SYNONYMS[t];
    if (synonym) return synonym;
    if ((t === "w" || t === "f") && index === tokens.length - 1) return "women";
    return t;
  });

  return RESERVE_TEAM_NAMES.reduce(
    (name, [pattern, replacement]) => name.replace(pattern, replacement),
    expanded.join(" ").replace(/\s+/g, " ").trim(),
  );
}

/**
 * Formas do mesmo nome que o tipster e o fornecedor escrevem diferente: o nome
 * em português (Bayern de Munique), a sigla do estado (Atlético-MG), a
 * abreviação (Man Utd, Jrs) e o time B que a Pinnacle chama de II. Cada linha
 * lista formas equivalentes, já canonicalizadas. A comparação fica com o melhor
 * entre o nome como veio e cada forma: a regra só acrescenta, e o nome original
 * continua valendo ("Atenas" segue casando o CA Atenas uruguaio). Por isso a
 * palavra que também é nome de time (Atenas, Colônia, Brasil, Turim = Torino,
 * Gênova = Genoa) só entra dentro do nome do clube ("aek atenas") ou fica de
 * fora: "Juventus de Turim" não pode virar o Torino. Sozinha, ela chega ao
 * clube por estar contida no nome dele, como "Bayern" em "Bayern Munich", e o
 * adversário decide entre os homônimos. As formas de uma linha têm sempre a
 * mesma categoria.
 */
export const TEAM_NAME_EQUIVALENTS: ReadonlyArray<readonly string[]> = [
  // Português (e grafia local) → como os fornecedores escrevem.
  ["munique", "munich", "munchen"],
  ["milao", "milan"],
  ["inter de milao", "inter milao", "inter milan", "internazionale"],
  ["hamburgo", "hamburg"],
  ["aek atenas", "aek athens"],
  ["fc colonia", "fc koln", "fc cologne"],
  ["viena", "vienna", "wien"],
  ["bucareste", "bucharest", "bucuresti"],
  ["marselha", "marseille"],
  ["sevilha", "sevilla"],
  ["napoles", "napoli"],
  ["lisboa", "lisbon"],
  ["moscou", "moscow"],
  ["praga", "prague", "praha"],
  ["varsovia", "warsaw", "warszawa"],
  ["belgrado", "belgrade"],
  ["estrela vermelha", "crvena zvezda"],
  ["copenhague", "copenhagen", "kobenhavn"],
  ["estocolmo", "stockholm"],
  ["salonica", "thessaloniki"],
  ["pireu", "piraeus"],
  ["bruges", "brugge"],
  ["antuerpia", "antwerp"],
  ["istambul", "istanbul"],
  ["berlim", "berlin"],
  ["friburgo", "freiburg"],
  ["estugarda", "stuttgart"],
  ["augsburgo", "augsburg"],
  ["gladbach", "m gladbach", "monchengladbach"],
  ["maiorca", "mallorca"],
  ["saragoca", "zaragoza"],
  ["corunha", "coruna"],
  ["espanhol", "espanyol"],
  ["bolonha", "bologna"],
  ["veneza", "venezia"],
  ["estrasburgo", "strasbourg"],
  ["bordeus", "bordeaux"],
  ["salzburgo", "salzburg"],
  ["zurique", "zurich"],
  ["basileia", "basel"],
  ["roterda", "rotterdam"],
  ["amsterda", "amsterdam"],
  ["edimburgo", "edinburgh"],
  ["olympiacos", "olympiakos"],
  ["dinamo", "dynamo"],
  ["kiev", "kyiv"],
  // Sigla do estado → o nome do clube na Pinnacle.
  ["atletico mg", "atletico mineiro"],
  ["america mg", "america mineiro"],
  ["athletico pr", "atletico pr", "athletico paranaense"],
  ["atletico go", "atletico goianiense"],
  ["operario pr", "operario ferroviario"],
  // Abreviações.
  ["man united", "manchester united"],
  ["man city", "manchester city"],
  ["sheff united", "sheffield united"],
  ["sheff wed", "sheff wednesday", "sheffield wednesday"],
  ["nottm forest", "nottingham forest"],
  ["qpr", "queens park rangers"],
  ["wolves", "wolverhampton"],
  ["spurs", "tottenham"],
  ["psg", "paris sg", "paris saint germain"],
  ["jrs", "juniors"],
  ["lp", "l p", "la plata"],
  ["v haugesund", "vard haugesund"],
  ["metalac gm", "metalac gornji milanovac"],
  ["internacional de bogota", "inter bogota"],
  // O Club NXT sempre carrega a marca de reserva (`RESERVE_TEAM_NAMES`): a
  // forma vale só quando as categorias dos dois lados já batem.
  ["club nxt", "club brugge"],
];

const EQUIVALENT_FORMS = new Map<string, string[]>();
for (const forms of TEAM_NAME_EQUIVALENTS) {
  for (const form of forms) {
    EQUIVALENT_FORMS.set(form, [...(EQUIVALENT_FORMS.get(form) ?? []), ...forms.filter((other) => other !== form)]);
  }
}
const MAX_EQUIVALENT_TOKENS = Math.max(...TEAM_NAME_EQUIVALENTS.flat().map((form) => form.split(" ").length));

/**
 * O time B que a Pinnacle chama de II ("Villarreal II" = "Villarreal B"), só no
 * fim do nome. Só nesse sentido: o II é da classe reserva, junto do U23, e o
 * "B" virando "II" casaria o time B com o sub-23 ("Barcelona B" ≠ "Barcelona
 * U23"). Como as duas pontas ganham variantes, "II" → "B" basta.
 */
const RESERVE_LETTER_FORMS: Readonly<Record<string, string>> = { ii: "b" };

const VARIANT_CACHE_LIMIT = 10_000;
const variantCache = new Map<string, readonly string[]>();

/**
 * As outras formas de um nome já canonicalizado, pelas equivalências acima
 * (vazia quando nenhuma regra se aplica, que é o caso comum). Cada trecho
 * trocável vira a primeira forma equivalente; as demais formas de cada trecho
 * dão uma variante cada.
 */
export function teamNameVariants(canon: string): readonly string[] {
  const cached = variantCache.get(canon);
  if (cached) return cached;
  const tokens = canon.split(" ").filter(Boolean);
  const swaps: Array<{ start: number; end: number; forms: readonly string[] }> = [];
  for (let i = 0; i < tokens.length;) {
    // O trecho mais longo ganha: "inter de milao" antes de "milao".
    let size = Math.min(MAX_EQUIVALENT_TOKENS, tokens.length - i);
    while (size > 0 && !EQUIVALENT_FORMS.has(tokens.slice(i, i + size).join(" "))) size -= 1;
    if (size === 0) {
      i += 1;
      continue;
    }
    swaps.push({ start: i, end: i + size, forms: EQUIVALENT_FORMS.get(tokens.slice(i, i + size).join(" "))! });
    i += size;
  }
  const last = tokens.length - 1;
  const reserve = last > 0 && swaps.at(-1)?.end !== tokens.length ? RESERVE_LETTER_FORMS[tokens[last]!] : undefined;

  const build = (pick: (swap: (typeof swaps)[number]) => string) => {
    const out: string[] = [];
    let position = 0;
    for (const swap of swaps) {
      out.push(...tokens.slice(position, swap.start), pick(swap));
      position = swap.end;
    }
    out.push(...tokens.slice(position));
    return out.filter(Boolean).join(" ");
  };
  const variants = new Set<string>();
  if (swaps.length > 0) {
    variants.add(build((swap) => swap.forms[0]!));
    for (const target of swaps) {
      for (const alternative of target.forms.slice(1)) {
        variants.add(build((swap) => (swap === target ? alternative : swap.forms[0]!)));
      }
    }
  }
  // O "II" → "B" é opcional em cada forma: "club brugge ii" vale como "club nxt
  // ii" e como "club nxt b".
  if (reserve) {
    for (const form of [canon, ...variants]) variants.add(`${form.slice(0, form.lastIndexOf(" "))} ${reserve}`);
  }
  variants.delete(canon);
  variants.delete("");
  const result = [...variants];
  if (variantCache.size >= VARIANT_CACHE_LIMIT) variantCache.clear();
  variantCache.set(canon, result);
  return result;
}

