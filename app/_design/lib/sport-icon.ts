import { normalizeStr } from "@/src/domain/text-normalization";

// Esporte da aposta -> ícone em /public/sports-icons. O `esporte` vem da
// resolução de esporte (src/domain/sports) com o nome canônico em inglês; os
// rótulos em português também são aceitos porque dado manual ou antigo chega
// assim.
// Esporte sem ícone ou ausente -> null: a tela usa o ícone genérico.

// Chaves sem acento e em minúsculas (ver normalizeStr); valor = nome do .png.
const SPORT_ICON: Readonly<Record<string, string>> = {
  soccer: "soccer",
  futebol: "soccer",
  basketball: "basketball",
  basquete: "basketball",
  tennis: "tennis",
  tenis: "tennis",
  volleyball: "volleyball",
  volei: "volleyball",
  voleibol: "volleyball",
  hockey: "hockey",
  hoquei: "hockey",
  baseball: "baseball",
  beisebol: "baseball",
  "american football": "football",
  "futebol americano": "football",
  handball: "handball",
  handebol: "handball",
  rugby: "rugby",
  rugbi: "rugby",
  badminton: "badminton",
  boxing: "boxing",
  boxe: "boxing",
  f1: "f1",
  "formula 1": "f1",
  esports: "esports",
  "e sports": "esports",
  "e-sports": "esports",
  // Variantes usam o ícone da família (futsal -> futebol, vôlei de praia ->
  // vôlei, tênis de mesa -> tênis). Críquete, MMA, golfe, dardos e sinuca ficam
  // sem ícone de propósito: o genérico é mais honesto que o de outro esporte.
  futsal: "soccer",
  "beach volleyball": "volleyball",
  "volei de praia": "volleyball",
  "table tennis": "tennis",
  "tenis de mesa": "tennis",
  "ping pong": "tennis",
};

/** Caminho do ícone do esporte, ou null quando não há ícone correspondente. */
export function sportIconSrc(esporte: string | null | undefined): string | null {
  if (!esporte) return null;
  const file = SPORT_ICON[normalizeStr(String(esporte))];
  return file ? `/sports-icons/${file}.png` : null;
}
