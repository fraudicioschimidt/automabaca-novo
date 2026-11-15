import { normalizeStr } from "@/src/domain/text";
import type { UnidadeDoPlacar } from "./types";
import { SPORTS_REGISTRY } from "@/src/domain/sports/registry-data";

export type { UnidadeDoPlacar };
export { SPORTS_REGISTRY } from "@/src/domain/sports/registry-data";

export type CanonicalSport = (typeof SPORTS_REGISTRY)[number]["canonical"];

/** Lista canônica — DERIVADA; nunca escrever à mão em outro lugar. */
export const CANONICAL_SPORTS: readonly CanonicalSport[] = SPORTS_REGISTRY.map(
  (entry) => entry.canonical,
);

/** Chave de lookup: sem acento, sem caixa, sem espaço. */
function chave(nome: string): string {
  return normalizeStr(nome).replace(/\s+/g, "");
}
const POR_CHAVE = new Map<string, CanonicalSport>(
  SPORTS_REGISTRY.flatMap((entry) =>
    [entry.canonical, ...entry.aliases].map(
      (nome) => [chave(nome), entry.canonical] as const,
    ),
  ),
);

export function canonicalSport(value: string | null | undefined): CanonicalSport | null {
  const key = chave(value ?? "");
  return key ? (POR_CHAVE.get(key) ?? null) : null;
}

export const EMOJI_SIGNALS: ReadonlyArray<readonly [string, CanonicalSport]> =
  SPORTS_REGISTRY.flatMap((entry) =>
    entry.emojis.map((emoji) => [emoji, entry.canonical] as const),
  );

export const TEXT_SIGNALS: ReadonlyArray<readonly [RegExp, CanonicalSport]> =
  SPORTS_REGISTRY.flatMap((entry) =>
    entry.texto ? [[entry.texto, entry.canonical] as const] : [],
  );

export const COMPETITION_SIGNALS: ReadonlyArray<readonly [RegExp, CanonicalSport]> =
  SPORTS_REGISTRY.flatMap((entry) =>
    entry.competicoes ? [[entry.competicoes, entry.canonical] as const] : [],
  );

/**
 * Nomes (canônico + aliases, normalizados COM espaço) das modalidades em que a
 * unidade dada é o placar. `SCORE_UNIT_RULES` casa esses termos por palavra
 * contra `Bet.esporte`, então aqui o espaço importa — "american football"
 * precisa continuar sendo duas palavras.
 */
export function esportesComUnidade(unidade: UnidadeDoPlacar): string[] {
  return SPORTS_REGISTRY.filter((entry) => entry.unidadeDoPlacar === unidade)
    .flatMap((entry) => [entry.canonical, ...entry.aliases])
    .map((nome) => normalizeStr(nome));
}

/**
 * O que o settlement por PLACAR pode fazer com cada unidade. Total de propósito:
 * `UnidadeDoPlacar` nova não compila até alguém decidir isto — senão uma
 * unidade que ninguém consome ("Total de Legs") iria direto para o caminho de
 * placar, julgada contra um número cuja unidade nunca foi medida.
 *
 * - `porEsporte`: vale só na lista de esportes daquela unidade — quem governa é
 *   `SCORE_UNIT_RULES` (gols, pontos, corridas).
 * - `naoMedido`: o registro DIZ que o feed entrega esta unidade, mas ninguém
 *   provou. A linha é recusada até uma sonda medir — e a recusa não afirma que o
 *   placar não responde, admite que não conferimos.
 * - `nunca`: não existe contagem entre dois lados (luta, golfe). Nenhuma medição
 *   vai mudar isso.
 *
 * Os dois últimos recusam igual, mas pelo motivo certo: vôlei declara
 * `unidadeDoPlacar: "sets"` e é `naoMedido`, não `nunca` — recusar o que não foi
 * medido é a regra da casa, e motivo errado faz a próxima pessoa "consertar" o
 * lado errado. Para promover `sets` a `porEsporte`, confira no feed real do
 * Flashscore, num jogo de vôlei, se `scores` vem 3x1 (sets) ou 75x68 (pontos).
 */
type TratamentoDaUnidade =
  | { modo: "porEsporte" }
  | { modo: "naoMedido"; termos: readonly string[] }
  | { modo: "nunca"; termos: readonly string[] };

const TRATAMENTO_DA_UNIDADE: Record<UnidadeDoPlacar, TratamentoDaUnidade> = {
  gols: { modo: "porEsporte" },
  pontos: { modo: "porEsporte" },
  corridas: { modo: "porEsporte" },
  // PLURAL nas unidades cujo singular é OUTRA coisa no vocabulário das casas:
  // "Game Handicap" é beisebol (unidade = corrida), "Leg 1 Winner" é jogo de
  // ida e volta no futebol, "Frame 1 Winner" e "Map 1 Winner" são o vencedor de
  // uma parcial. Todos já são recusados por outra regra — o que o plural evita
  // é recusá-los pelo motivo ERRADO, que é como um diagnóstico vira mentira.
  // `sets` mantém o singular porque é o comportamento que já existia.
  games: { modo: "naoMedido", termos: ["games"] },
  sets: { modo: "naoMedido", termos: ["sets?"] },
  legs: { modo: "naoMedido", termos: ["legs"] },
  frames: { modo: "naoMedido", termos: ["frames"] },
  mapas: { modo: "naoMedido", termos: ["mapas", "maps"] },
  /** Luta e golfe não têm contagem entre dois lados; não há termo a recusar. */
  outra: { modo: "nunca", termos: [] },
};

/**
 * Termos de unidade que NUNCA liquidam por placar, derivados das modalidades
 * que o sistema realmente modela. Esporte novo com unidade nova entra aqui
 * sozinho — sem isso, dardos e snooker liquidariam por um placar de unidade
 * desconhecida.
 */
export function termosDeUnidadeSemPlacar(): string[] {
  const unidades = new Set(SPORTS_REGISTRY.map((entry) => entry.unidadeDoPlacar));
  return [...unidades].flatMap((unidade) => {
    const tratamento = TRATAMENTO_DA_UNIDADE[unidade];
    // `naoMedido` e `nunca` recusam igual — o que muda é o que a recusa AFIRMA,
    // e é isso que diz a quem lê se vale a pena medir.
    return tratamento.modo === "naoMedido" || tratamento.modo === "nunca"
      ? [...tratamento.termos]
      : [];
  });
}
