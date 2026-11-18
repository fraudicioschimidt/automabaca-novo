/**
 * O registro das modalidades. Os dados estão em `registry-data.json`, que o
 * TypeScript importa (o tipo `CanonicalSport` sai das chaves) e o crate
 * `dominio` lê na compilação (`rust/crates/dominio/build.rs`, que também
 * recusa unidade de placar desconhecida). Os padrões vão como fonte de regex,
 * sem flags, sobre o texto normalizado do post.
 *
 * Notas dos padrões do futebol, que o JSON não comporta:
 * - "Serie A", "La Liga" e "Champions League" também nomeiam ligas de
 *   basquete, vôlei, handebol e futsal ("Lega Basket Serie A", "La Liga
 *   Endesa", "EHF/FIBA/CEV Champions League"): com a palavra de outra
 *   modalidade no texto, não confirmam futebol. Se o texto também traz outra
 *   modalidade, `detectSportFromText` aplica a guarda linha a linha, porque a
 *   outra linha pode ser de outro jogo do post.
 * - O lookbehind dessas ligas vem DEPOIS do nome ("champions league(?<!…[\s\S]*
 *   champions league)"), e não antes: diz o mesmo, mas só é avaliado onde o
 *   nome casou. Antes do nome, o `[\s\S]*` era avaliado em toda posição do
 *   texto, quadrático no motor de regex do servidor.
 * - "Indian/Caribbean/Lanka Premier League" são do críquete, e "PDC Premier
 *   League", dos dardos; "Bangladesh Premier League" nomeou as ligas de
 *   futebol (até 2025) e de críquete, e não prova nenhuma das duas.
 */
import data from "./registry-data.json";
import type { SportEntry, UnidadeDoPlacar } from "./types";

type RegistryEntry = SportEntry & { readonly canonical: keyof typeof data };

const pattern = (source: string | null): RegExp | null => (source === null ? null : new RegExp(source));

export const SPORTS_REGISTRY: readonly RegistryEntry[] = Object.freeze(
  (Object.keys(data) as (keyof typeof data)[]).map((canonical): RegistryEntry => {
    const entry = data[canonical];
    return Object.freeze({
      canonical,
      labelPt: entry.labelPt,
      aliases: entry.aliases,
      emojis: entry.emojis,
      texto: pattern(entry.texto),
      competicoes: pattern(entry.competicoes),
      flashscoreId: entry.flashscoreId,
      unidadeDoPlacar: entry.unidadeDoPlacar as UnidadeDoPlacar,
    });
  }),
);
