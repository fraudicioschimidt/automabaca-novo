export type UnidadeDoPlacar =
  | "gols"
  | "pontos"
  | "corridas"
  | "sets"
  | "games"
  | "legs"
  | "frames"
  | "mapas"
  /** Sem contagem entre dois lados (luta, golfe): placar não liquida. */
  | "outra";

export type SportEntry = {
  /** Nome persistido em `Bet.esporte`. EN, como manda a convenção do schema. */
  readonly canonical: string;
  /** Como o operador chama a modalidade. É o rótulo de toda tela (UI em PT-BR). */
  readonly labelPt: string;
  /** Outras grafias aceitas ao normalizar um esporte já escrito. */
  readonly aliases: readonly string[];
  /** Emoji que sozinho confirma a modalidade — só os inequívocos. */
  readonly emojis: readonly string[];
  /** Padrão sobre o texto normalizado do post. */
  readonly texto: RegExp | null;
  /** Ligas/torneios que identificam a modalidade sem ela ser nomeada. */
  readonly competicoes: RegExp | null;
  /** Id do esporte no FlashScore, quando medido. */
  readonly flashscoreId: number | null;
  readonly unidadeDoPlacar: UnidadeDoPlacar;
};
