import { describe, expect, it } from "vitest";
import {
  MOTIVOS_FORA_DA_BASE,
  NO_ODDS_REASONS,
  foraDaBaseDeCobertura,
  missingClvReason,
} from "@/src/domain/no-odds-reason";
import {
  baseAlcancavel,
  perdasPorMotivo,
  situacaoDoClv,
  situacaoDaAbertura,
} from "@/src/domain/analyzer/cobertura";
import type { SituacaoDeCobertura } from "@/src/domain/analyzer/cobertura";
import { textoDeCobertura } from "@/app/_design/lib/cobertura-na-tela";
import type { BetRowData } from "@/src/domain/bet-read-model";

/**
 * Percentual de cobertura não divide pelo conjunto inteiro.
 *
 * O risco: a métrica contar no DENOMINADOR apostas que ela não pode alcançar
 * (pendentes, ao vivo) e se medir como falha por não responder pergunta que
 * ninguém fez. O número sai plausível e menor, e esconde a diferença entre um
 * canal sem lacuna nenhuma e um canal cheio delas.
 *
 * Difere do `resumo-de-apostas` (cabeçalho conta uma base, lista conta outra):
 * lá as duas bases existem e divergem; aqui a base está certa e o denominador é
 * que inclui quem nunca poderia estar no numerador.
 */

// ───────────────────────── (a) o vocabulário ─────────────────────────

describe("todo motivo declara o que a ausência significa para a base", () => {
  it("nenhum motivo fica sem `base`, e só existem os três valores previstos", () => {
    // Lido pelo tipo LARGO de propósito: com o literal, o TS estreita o ramo
    // inválido para `never` e o check some em tempo de compilação — deixando
    // passar exatamente o caso que este teste existe para pegar (um `as` numa
    // entrada nova, ou uma linha vinda de outra versão).
    const vocabulario = NO_ODDS_REASONS as Record<string, { base?: string }>;
    const invalidos = Object.entries(vocabulario).flatMap(([slug, spec]) =>
      ["nao_se_aplica", "fornecedor", "sistema"].includes(String(spec.base)) ? [] : [`${slug}: ${String(spec.base)}`],
    );
    expect(
      invalidos,
      invalidos.length === 0
        ? ""
        : `Motivo com \`base\` fora do vocabulário:\n  • ${invalidos.join("\n  • ")}\n\n` +
            `Só existem "nao_se_aplica" (fora do denominador), "fornecedor" e "sistema" (dentro).`,
    ).toEqual([]);
  });

  it("os dois lados existem — vocabulário todo de um lado não separa nada", () => {
    const total = Object.keys(NO_ODDS_REASONS).length;
    expect(total).toBeGreaterThan(10);
    expect(MOTIVOS_FORA_DA_BASE.length).toBeGreaterThan(0);
    expect(MOTIVOS_FORA_DA_BASE.length).toBeLessThan(total);
  });

  it("`permanent` e `base` NÃO são sinônimos — confundir os dois é o erro fácil", () => {
    // unsupported_market: re-caçar odd não adianta (permanent), mas COMPRAR
    // cobertura adianta (fornecedor). Some do denominador = esconder a conta.
    expect(NO_ODDS_REASONS.unsupported_market.permanent).toBe(true);
    expect(NO_ODDS_REASONS.unsupported_market.base).toBe("fornecedor");
    expect(foraDaBaseDeCobertura("unsupported_market")).toBe(false);
    expect(NO_ODDS_REASONS.sem_referencia_sharp.permanent).toBe(true);
    expect(NO_ODDS_REASONS.sem_referencia_sharp.base).toBe("nao_se_aplica");
    expect(foraDaBaseDeCobertura("sem_referencia_sharp")).toBe(true);
    // aposta_ao_vivo: permanente E fora da base — CLV não existe, por definição.
    expect(foraDaBaseDeCobertura("aposta_ao_vivo")).toBe(true);
  });

  it("motivo desconhecido NÃO sai da base — o viés é contra nós, de propósito", () => {
    // Linha antiga ou de versão futura: contar como alcançável mantém a
    // cobertura pessimista. Otimismo silencioso é a doença que isto veio curar.
    expect(foraDaBaseDeCobertura("motivo_que_nao_existe")).toBe(false);
    expect(foraDaBaseDeCobertura(null)).toBe(false);
    expect(foraDaBaseDeCobertura(undefined)).toBe(false);
  });
});

// ───────────────────────── (b) a aritmética ─────────────────────────

type LinhaFake = Pick<
  BetRowData,
  | "status" | "clv" | "clvReliable" | "closingFetchedAt"
  | "closingNoOddsReason" | "noOddsReason" | "openingNoOddsReason" | "stake" | "mercado"
>;

const linha = (over: Partial<LinhaFake> = {}): LinhaFake => ({
  status: "WON",
  clv: null,
  clvReliable: null,
  closingFetchedAt: null,
  closingNoOddsReason: null,
  noOddsReason: null,
  openingNoOddsReason: null,
  stake: 1,
  mercado: "Moneyline",
  ...over,
});

/** Uma aposta com CLV utilizável: fechamento congelado e confiável. */
const comClv = (over: Partial<LinhaFake> = {}): LinhaFake =>
  linha({ clv: 4, clvReliable: true, closingFetchedAt: new Date("2026-08-01T12:00:00Z"), ...over });

describe("baseAlcancavel separa o que a métrica alcança do que não alcança", () => {
  it("classifica as cinco situações do CLV", () => {
    expect(situacaoDoClv(comClv())).toBe("tem");
    expect(situacaoDoClv(linha({ status: "PENDING" }))).toBe("cedo");
    expect(situacaoDoClv(linha({ closingNoOddsReason: "aposta_ao_vivo" }))).toBe("nao_se_aplica");
    expect(situacaoDoClv(linha({ closingNoOddsReason: "unsupported_market" }))).toBe("lacuna");
    // Liquidada, sem CLV e sem motivo: silêncio. É o pior caso e tem nome próprio.
    expect(situacaoDoClv(linha({ status: "LOST" }))).toBe("sem_explicacao");
  });

  it.each([null, "identidade_nao_casada"])("CLV já congelado sem número utilizável não fica cedo por liquidação pendente (%s)", (reason) => {
    const pending = linha({ status: "PENDING", closingFetchedAt: new Date("2026-10-09T12:00:00Z"), noOddsReason: reason });
    expect(situacaoDoClv(pending)).toBe(reason ? "lacuna" : "sem_explicacao");
    const coverage = baseAlcancavel([comClv(), pending], situacaoDoClv);
    expect(coverage.pct).toBe(50);
    expect(coverage.cedo).toHaveLength(0);
  });

  it("entrada ao vivo PENDENTE é `nao_se_aplica`, não `cedo`", () => {
    // A ordem da checagem importa: `cedo` sugeriria que basta esperar o apito,
    // e uma entrada ao vivo nunca vira pré-jogo.
    expect(situacaoDoClv(linha({ status: "PENDING", closingNoOddsReason: "aposta_ao_vivo" })))
      .toBe("nao_se_aplica");
  });

  it("sem fechamento, o CLV lê o motivo da identidade que alcança o fechamento", () => {
    // Múltipla e banca só identidade nunca ganham bet_closing: fora da base, mesmo pendentes.
    expect(situacaoDoClv(linha({ status: "LOST", noOddsReason: "multipla" }))).toBe("nao_se_aplica");
    expect(situacaoDoClv(linha({ status: "LOST", noOddsReason: "identity_only" }))).toBe("nao_se_aplica");
    expect(situacaoDoClv(linha({ status: "PENDING", noOddsReason: "identity_only" }))).toBe("nao_se_aplica");
    // Motivo do fornecedor ou nosso: lacuna com nome, não silêncio.
    expect(situacaoDoClv(linha({ status: "LOST", noOddsReason: "identidade_nao_casada" }))).toBe("lacuna");
    expect(situacaoDoClv(linha({ status: "LOST", noOddsReason: "evento_sem_formato" }))).toBe("lacuna");
    // Pendente ainda pode casar: a revisão da identidade reabre UNMATCHED.
    expect(situacaoDoClv(linha({ status: "PENDING", noOddsReason: "identidade_nao_casada" }))).toBe("cedo");
    // `clv_only` fala da entrada: sem fechamento continua silêncio.
    expect(situacaoDoClv(linha({ status: "LOST", noOddsReason: "clv_only" }))).toBe("sem_explicacao");
    // O motivo do fechamento vem primeiro.
    expect(situacaoDoClv(linha({ status: "LOST", noOddsReason: "multipla", closingNoOddsReason: "no_prices" })))
      .toBe("lacuna");
  });

  it("banca só identidade não tem base alcançável de CLV", () => {
    const c = baseAlcancavel(
      [linha({ status: "LOST", noOddsReason: "identity_only" }), linha({ status: "WON", noOddsReason: "identity_only" })],
      situacaoDoClv,
    );
    expect(c.base).toHaveLength(0);
    expect(c.pct).toBeNull();
  });

  it("a abertura lê o motivo da própria abertura, não o da identidade", () => {
    // `clv_only` fala da entrada: a aposta sem abertura continua na base.
    expect(situacaoDaAbertura(linha({ noOddsReason: "clv_only" }), false)).toBe("sem_explicacao");
    expect(situacaoDaAbertura(linha({ noOddsReason: "clv_only", openingNoOddsReason: "partida_nao_localizada" }), false))
      .toBe("lacuna");
    // Política que desliga todo preço da aposta tira a abertura da base.
    expect(situacaoDaAbertura(linha({ noOddsReason: "identity_only" }), false)).toBe("nao_se_aplica");
    expect(situacaoDaAbertura(linha({ noOddsReason: "multipla" }), false)).toBe("nao_se_aplica");
    // A coleta espera o jogo: pendente sem tentativa ainda é cedo.
    expect(situacaoDaAbertura(linha({ status: "PENDING" }), false)).toBe("cedo");
    expect(situacaoDaAbertura(linha({ status: "PENDING", noOddsReason: "clv_only" }), true)).toBe("tem");
  });

  it("cobertura de abertura com clv_only não sai do denominador", () => {
    const comAbertura = linha({ noOddsReason: "clv_only" });
    const semAbertura = linha({ noOddsReason: "clv_only", openingNoOddsReason: "sem_abertura_na_linha" });
    const c = baseAlcancavel([comAbertura, semAbertura], (b) => situacaoDaAbertura(b, b === comAbertura));
    expect(c.pct).toBe(50);
  });

  it("o denominador exclui `cedo` e `nao_se_aplica`, e inclui os dois buracos", () => {
    const bets: LinhaFake[] = [
      comClv(), comClv(), comClv(),                                   // 3 tem
      linha({ status: "PENDING" }),                                   // 1 cedo
      linha({ closingNoOddsReason: "aposta_ao_vivo" }),               // 1 não se aplica
      linha({ closingNoOddsReason: "unsupported_market" }),           // 1 lacuna
      linha({ status: "LOST" }),                                      // 1 sem explicação
    ];
    const c = baseAlcancavel(bets, situacaoDoClv);
    expect(c.cobertas).toHaveLength(3);
    expect(c.faltando).toHaveLength(2);
    expect(c.cedo).toHaveLength(1);
    expect(c.naoSeAplica).toHaveLength(1);
    expect(c.base).toHaveLength(5);
    expect(c.pct).toBe(60);
    // Dividir por tudo daria 43%, e a diferença é a mentira.
    expect(Math.round((c.cobertas.length / bets.length) * 100)).toBe(43);
  });

  it("partição com pendentes e ao vivo: 70% da base alcançável, não 53% do total", () => {
    const bets = [
      ...Array.from({ length: 86 }, () => comClv()),
      ...Array.from({ length: 26 }, () => linha({ closingNoOddsReason: "aposta_ao_vivo" })),
      ...Array.from({ length: 12 }, () => linha({ status: "PENDING" })),
      ...Array.from({ length: 27 }, () => linha({ closingNoOddsReason: "unsupported_market" })),
      ...Array.from({ length: 10 }, () => linha({ status: "LOST" })),
    ];
    expect(bets).toHaveLength(161);
    const c = baseAlcancavel(bets, situacaoDoClv);
    expect(c.base).toHaveLength(123);
    expect(Math.round(c.pct ?? 0)).toBe(70);
    expect(textoDeCobertura(c)).toBe("70% — 86 de 123 alcançáveis");
  });

  it("base vazia devolve `null`, nunca 0% — não existe fração de nada", () => {
    const soFora = [
      linha({ status: "PENDING" }),
      linha({ closingNoOddsReason: "aposta_ao_vivo" }),
    ];
    const c = baseAlcancavel(soFora, situacaoDoClv);
    expect(c.pct).toBeNull();
    expect(textoDeCobertura(c)).toBe("sem base alcançável no recorte");
    expect(baseAlcancavel([], situacaoDoClv).pct).toBeNull();
  });

  it("cobertura total é 100%, e o cartão de perda não tem o que mostrar", () => {
    const c = baseAlcancavel([comClv(), comClv()], situacaoDoClv);
    expect(c.pct).toBe(100);
    expect(perdasPorMotivo(c.faltando, (b) => b.closingNoOddsReason)).toEqual([]);
  });

  it("o texto declara a base — é o que o número sozinho não faz", () => {
    const c = baseAlcancavel([comClv(), linha({ status: "LOST" })], situacaoDoClv);
    // Sem "de N alcançáveis" o operador não tem como saber contra o quê mediu.
    expect(textoDeCobertura(c)).toContain("de 2 alcançáveis");
    const uma = baseAlcancavel([comClv()], situacaoDoClv);
    expect(uma.pct).toBe(100);
    expect(textoDeCobertura(uma)).toContain("1 alcançável");
  });
});

describe("perdasPorMotivo transforma o buraco em decisão", () => {
  it("agrupa por motivo, soma o stake e nomeia o mercado dominante", () => {
    const faltando: LinhaFake[] = [
      ...Array.from({ length: 9 }, () =>
        linha({ closingNoOddsReason: "unsupported_market", mercado: "Total (Bookings) – Match", stake: 1.5 })),
      linha({ closingNoOddsReason: "unsupported_market", mercado: "Team Total", stake: 1 }),
      ...Array.from({ length: 4 }, () =>
        linha({ closingNoOddsReason: "line_mismatch", mercado: "Point Spread", stake: 2 })),
    ];
    const perdas = perdasPorMotivo(faltando, (b) => b.closingNoOddsReason);
    expect(perdas).toHaveLength(2);
    const [maior, menor] = perdas;
    // Maior buraco primeiro — é a ordem em que a decisão se toma.
    expect(maior?.motivo).toBe("unsupported_market");
    expect(maior?.n).toBe(10);
    expect(maior?.stake).toBeCloseTo(14.5, 6);
    expect(maior?.rotulo).toBe("modalidade ou mercado sem cobertura sharp");
    expect(maior?.mercadoDominante).toBe("Total (Bookings) – Match");
    expect(maior?.nDoMercado).toBe(9);
    expect(menor?.motivo).toBe("line_mismatch");
    expect(menor?.n).toBe(4);
  });

  it("o balde sem motivo tem rótulo próprio — silêncio não é lacuna", () => {
    const perdas = perdasPorMotivo([linha({ status: "LOST" })], (b) => b.closingNoOddsReason);
    expect(perdas[0]?.motivo).toBeNull();
    expect(perdas[0]?.rotulo).toBe("sem motivo gravado");
  });

  it("com o motivo de `missingClvReason`, a identidade não casada tem balde próprio", () => {
    const naoCasadas = [linha({ status: "LOST", noOddsReason: "identidade_nao_casada" }),
      linha({ status: "WON", noOddsReason: "identidade_nao_casada" })];
    const c = baseAlcancavel([...naoCasadas, linha({ status: "LOST", noOddsReason: "multipla" })], situacaoDoClv);
    const perdas = perdasPorMotivo(c.faltando, missingClvReason);
    expect(perdas.map((p) => [p.motivo, p.n])).toEqual([["identidade_nao_casada", 2]]);
  });

  it("`membros` é o array agregado — é o que a gaveta abre, sem refazer filtro", () => {
    const a = linha({ closingNoOddsReason: "no_prices" });
    const b = linha({ closingNoOddsReason: "no_prices" });
    const [perda] = perdasPorMotivo([a, b], (x) => x.closingNoOddsReason);
    expect(perda?.membros).toHaveLength(2);
    expect(perda?.membros[0]).toBe(a);
    expect(perda?.n).toBe(perda?.membros.length);
  });
});

// Garante que o tipo é usado — e documenta as cinco situações num só lugar.
const TODAS_AS_SITUACOES: readonly SituacaoDeCobertura[] = [
  "tem", "cedo", "nao_se_aplica", "lacuna", "sem_explicacao",
];

describe("o vocabulário de situações não encolhe em silêncio", () => {
  it("as cinco situações continuam alcançáveis por algum caminho", () => {
    const vistas = new Set<SituacaoDeCobertura>([
      situacaoDoClv(comClv()),
      situacaoDoClv(linha({ status: "PENDING" })),
      situacaoDoClv(linha({ closingNoOddsReason: "aposta_ao_vivo" })),
      situacaoDoClv(linha({ closingNoOddsReason: "unsupported_market" })),
      situacaoDoClv(linha({ status: "LOST" })),
    ]);
    expect([...vistas].sort()).toEqual([...TODAS_AS_SITUACOES].sort());
  });
});
