import { normalizeStr } from "@/src/domain/text-normalization";

// Casa de aposta -> logo em /public/bookmakers. O nome vem do cadastro da conta,
// então aceita variações: "Bet365", "Bet 365", "Casa de Apostas", "stake.bet.br".

const BOOKMAKER_FILES = new Set([
  "1pra1",
  "7games",
  "7k",
  "ai",
  "aposta1",
  "apostabet",
  "apostaganha",
  "apostou",
  "bandbet",
  "bateu",
  "bet365",
  "betano",
  "betboo",
  "betboom",
  "betbra",
  "betesporte",
  "betfair",
  "betfast",
  "betnacional",
  "betou",
  "betpix365",
  "betpontobet",
  "betsson",
  "betwarrior",
  "bingobet",
  "blaze",
  "bolsadeaposta",
  "br4",
  "bravobet",
  "brbet",
  "brxbet",
  "casadeapostas",
  "cassino",
  "cbesportes",
  "donosdabola",
  "esportesdasorte",
  "esportivabet",
  "estrelabet",
  "faz1bet",
  "fulltbet",
  "galerabet",
  "hiperbet",
  "jogodeouro",
  "kto",
  "lancedesorte",
  "lottu",
  "luck",
  "multibet",
  "novibet",
  "pagol",
  "pinnacle",
  "pixbet",
  "reidopitaco",
  "segurobet",
  "sortenabet",
  "sportingbet",
  "sportybet",
  "stake",
  "superbet",
  "upbet",
  "vaidebet",
  "vbet",
  "versus",
  "vivasorte",
  "zeroum",
]);

const BOOKMAKER_ALIASES: Readonly<Record<string, string>> = {
  "1para1": "1pra1",
  "1pra1bet": "1pra1",
  umpraum: "1pra1",
  umpra1: "1pra1",
  aibet: "ai",
  apostaum: "aposta1",
  aposta1bet: "aposta1",
  betponto: "betpontobet",
  casadeaposta: "casadeapostas",
  cb: "cbesportes",
  donosdabola: "donosdabola",
  donodabola: "donosdabola",
  esportedasorte: "esportesdasorte",
  esportivabetbr: "esportivabet",
  jogodeourobetbr: "jogodeouro",
  jogoouro: "jogodeouro",
  lancesorte: "lancedesorte",
  lancedasorte: "lancedesorte",
  reidopitaco: "reidopitaco",
  seguro: "segurobet",
  stakebetbr: "stake",
  zero1: "zeroum",
  zeroum: "zeroum",
};

export function normalizeBookmakerName(name: string | null | undefined): string {
  return normalizeStr(String(name || ""))
    .replace(/&/g, "e")
    .replace(/[^a-z0-9]/g, "");
}

/** Caminho da logo da casa, ou null quando ainda não há imagem correspondente. */
export function bookmakerLogoSrc(name: string | null | undefined): string | null {
  const key = normalizeBookmakerName(name);
  if (!key) return null;
  const file = BOOKMAKER_ALIASES[key] ?? key;
  return BOOKMAKER_FILES.has(file) ? `/bookmakers/${file}.png` : null;
}
