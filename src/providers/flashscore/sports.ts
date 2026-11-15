import { SPORTS_REGISTRY, type CanonicalSport } from "@/src/domain/sports/registry";
import { normalizeStr } from "@/src/domain/text";

/**
 * Esportes do FlashScore. Três capacidades distintas, que não se confundem:
 * **encontrar** o evento, **liquidar por flag** e **liquidar por inferência**.
 * Só parte dos esportes popula `match_status`; nos outros o placar vem, mas
 * `is_finished` fica `false` para sempre, mesmo dias depois do jogo.
 *
 * `modo`:
 * - `flag`     — o feed marca status terminal e liquida imediatamente.
 * - `inferido` — sem flag, mas com placar utilizável. Liquida só depois de
 *                `esperaMs` e de confirmação de estabilidade.
 * - `nenhum`   — só serve para ENCONTRAR o evento (resolver esporte e kickoff).
 *
 * `esperaMs` sai de medição, não de palpite: o feed mostra placar PARCIAL bem
 * depois do kickoff (handebol a +89min, críquete a +179). O portão é sempre
 * folgado sobre a duração máxima plausível, porque liquidar cedo é dinheiro
 * invertido e liquidar tarde só custa latência.
 */
export type FlashscoreModo = "flag" | "inferido" | "nenhum";

export type FlashscoreSport = {
  readonly sport: string;
  readonly sportId: number;
  readonly modo: FlashscoreModo;
  /** Só para `inferido`: mínimo após o kickoff antes de aceitar o placar. */
  readonly esperaMs?: number;
};

const H = 3_600_000;

export const FLASHSCORE_SPORTS = [
  // ── Liquidam por flag do fornecedor ──
  { sport: "Soccer", sportId: 1, modo: "flag" },
  { sport: "Tennis", sportId: 2, modo: "flag" },
  { sport: "Basketball", sportId: 3, modo: "flag" },
  { sport: "Hockey", sportId: 4, modo: "flag" },

  // ── Liquidam por inferência (placar numérico, sem flag) ──
  // Esperas folgadas sobre a duração máxima plausível de cada modalidade.
  { sport: "American Football", sportId: 5, modo: "inferido", esperaMs: 6 * H },
  { sport: "Baseball", sportId: 6, modo: "inferido", esperaMs: 6 * H },
  { sport: "Handball", sportId: 7, modo: "inferido", esperaMs: 4 * H },
  { sport: "Rugby Union", sportId: 8, modo: "inferido", esperaMs: 4 * H },
  { sport: "Futsal", sportId: 11, modo: "inferido", esperaMs: 4 * H },
  { sport: "Volleyball", sportId: 12, modo: "inferido", esperaMs: 5 * H },
  // Críquete vai de T20 (~3,5h) a Test match (DIAS). A medição pegou placar
  // mudando em kickoff+179min; 12h ainda é pouco para Test, então o formato
  // longo continua caindo para settlement manual — e é o desfecho honesto.
  { sport: "Cricket", sportId: 13, modo: "inferido", esperaMs: 12 * H },
  { sport: "Darts", sportId: 14, modo: "inferido", esperaMs: 6 * H },
  { sport: "Snooker", sportId: 15, modo: "inferido", esperaMs: 8 * H },
  { sport: "Beach Volleyball", sportId: 17, modo: "inferido", esperaMs: 4 * H },
  { sport: "Rugby League", sportId: 19, modo: "inferido", esperaMs: 4 * H },
  { sport: "Badminton", sportId: 21, modo: "inferido", esperaMs: 4 * H },
  { sport: "Field Hockey", sportId: 24, modo: "inferido", esperaMs: 4 * H },
  { sport: "Table Tennis", sportId: 25, modo: "inferido", esperaMs: 4 * H },
  { sport: "Beach Soccer", sportId: 26, modo: "inferido", esperaMs: 4 * H },
  { sport: "Netball", sportId: 29, modo: "inferido", esperaMs: 4 * H },
  { sport: "Pesapallo", sportId: 30, modo: "inferido", esperaMs: 5 * H },
  // eSports: Bo5 de CS2/LoL passa de 4h. A medição não flagrou placar parcial
  // em 39 partidas, mas a amostra não cobre série longa — espera generosa.
  { sport: "eSports", sportId: 36, modo: "inferido", esperaMs: 6 * H },

  // ── Nunca liquidam: o fornecedor não publica placar utilizável ──
  // Boxe e MMA devolvem `("TKO/2","TKO/2")` — método e round em STRING, igual
  // dos dois lados. Não é contagem, é o desfecho da luta escrito por extenso.
  { sport: "Boxing", sportId: 16, modo: "nenhum" },
  { sport: "MMA", sportId: 28, modo: "nenhum" },
  // Futebol australiano: 0 placar em 25 partidas medidas.
  { sport: "Aussie Rules", sportId: 18, modo: "nenhum" },
  // Devolve `(55, 35)` — número sem semântica de disputa entre dois lados.
  { sport: "Moto Racing", sportId: 33, modo: "nenhum" },

  // ── Publicados em `/general/sports`, SEM medição nossa ──
  // Nada foi medido sobre estes: nem se o placar vem, nem em que unidade, nem se
  // há flag. Entram `nenhum` por disciplina fail-closed — mapeados só para
  // ENCONTRAR o evento. Para liquidar, conferir no feed real do Flashscore num
  // dia com jogo da modalidade.
  { sport: "Floorball", sportId: 9, modo: "nenhum" },
  { sport: "Bandy", sportId: 10, modo: "nenhum" },
  { sport: "Water Polo", sportId: 22, modo: "nenhum" },
  { sport: "Golf", sportId: 23, modo: "nenhum" },
  { sport: "Motorsport", sportId: 31, modo: "nenhum" },
  { sport: "Cycling", sportId: 34, modo: "nenhum" },
  { sport: "Horse Racing", sportId: 35, modo: "nenhum" },
  { sport: "Winter Sports", sportId: 37, modo: "nenhum" },
  { sport: "Kabaddi", sportId: 42, modo: "nenhum" },
] as const satisfies readonly FlashscoreSport[];

function chave(nome: string): string {
  return normalizeStr(nome).replace(/\s+/g, "");
}

/**
 * Grafias que só interessam ao PROVIDER: modalidades que o AutomaBACA não
 * modela, mais apelidos de catálogo. Servem para ENCONTRAR o evento, nunca para
 * virar `Bet.esporte`.
 *
 * Não pode colidir com nome nem alias do registro do domínio — um teste cobra
 * isso. Uma colisão daria duas respostas para a mesma pergunta, decididas por
 * ordem de inserção num `Map`.
 */
export const FLASHSCORE_SPORT_IDS_SO_DO_PROVIDER: ReadonlyArray<readonly [string, number]> = [
  ["football", 1],
  ["fieldhockey", 24], ["hoqueisobregrama", 24],
  ["beachsoccer", 26], ["futeboldepraia", 26],
  ["netball", 29],
  // 30 é Superpesis (pesäpallo finlandês), não beisebol; o beisebol de
  // verdade — NPB, KBO, LMB — é 6.
  ["pesapallo", 30], ["pesäpallo", 30],
  ["motoracing", 33], ["motorsport", 31], ["automobilismo", 31],
  ["esport", 36],
  ["floorball", 9], ["bandy", 10],
  ["horseracing", 35], ["turfe", 35],
  ["wintersports", 37], ["esportesdeinverno", 37],
  ["kabaddi", 42],
];

const SPORT_IDS = new Map<string, number>([
  // Grafias do provider PRIMEIRO: o registro do domínio entra depois e vence
  // qualquer colisão, porque ele é a fonte de verdade. Na ordem inversa a
  // lista auxiliar sobrescreveria o registro sem ninguém notar.
  ...FLASHSCORE_SPORT_IDS_SO_DO_PROVIDER,
  // Modalidades canônicas: o id vem do REGISTRO do domínio, com todos os
  // aliases dele. Uma segunda lista aqui deixaria "Rugby" existir no sistema
  // sem achar partida nenhuma no provider.
  ...SPORTS_REGISTRY.flatMap((entry) => {
    const id = entry.flashscoreId;
    if (id === null) return [];
    return [entry.canonical, ...entry.aliases].map(
      (nome) => [chave(nome), id] as const,
    );
  }),
]);

const POR_ID = new Map<number, FlashscoreSport>(
  FLASHSCORE_SPORTS.map((item) => [item.sportId, item]),
);

export function flashscoreSportId(sport: string): number | null {
  return SPORT_IDS.get(normalizeStr(sport).replace(/\s+/g, "")) ?? null;
}

export function flashscoreSportPerfil(sportId: number): FlashscoreSport | null {
  return POR_ID.get(sportId) ?? null;
}

/**
 * Subconjunto que o AutomaBACA sabe MODELAR, casado pelo ID e não pelo nome.
 *
 * O catálogo do FlashScore inclui esportes que o registro do domínio não
 * modela. Casar por NOME parecia equivalente e não é: o registro chama a
 * modalidade de `Rugby`
 * (um canônico só, porque os providers de odds tratam rugby como um bucket) e o
 * provider a chama de `Rugby Union` — a comparação textual descartaria a
 * modalidade em silêncio, e a resolução de esporte nunca a proporia. O id é a
 * chave que os dois lados concordam.
 */
export const FLASHSCORE_CANONICAL_SPORTS: ReadonlyArray<
  Omit<FlashscoreSport, "sport"> & { sport: CanonicalSport }
> = SPORTS_REGISTRY.flatMap((entry) => {
  const perfil = entry.flashscoreId === null ? null : POR_ID.get(entry.flashscoreId);
  return perfil ? [{ ...perfil, sport: entry.canonical }] : [];
});

/**
 * true quando observar o resultado neste esporte pode terminar em liquidação —
 * por flag OU por inferência. Fail-closed: id desconhecido não liquida.
 */
export function flashscoreSettlesSportId(sportId: number): boolean {
  const perfil = POR_ID.get(sportId);
  return perfil ? perfil.modo !== "nenhum" : false;
}
