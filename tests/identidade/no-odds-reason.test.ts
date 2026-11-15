import { describe, expect, it } from "vitest";
import {
  NO_ODDS_REASONS,
  PERMANENT_NO_ODDS_REASONS,
  SUPPLIER_NO_ODDS_REASONS,
  foraDaBaseDeCobertura,
  isPermanentNoOddsReason,
  missingClvReason,
  noOddsReasonBase,
  noOddsReasonLabel,
} from "@/src/domain/no-odds-reason";

/**
 * Portão do vocabulário de `noOddsReason`.
 *
 * A classe do defeito: o código grava motivo que a tela não sabe traduzir, e o
 * operador vê `sport_pending` cru. O tipo em `SharpUpsertData` e
 * `ClosingWriteData` já impede motivo novo de COMPILAR fora do SSOT; este teste
 * fecha o resto — que todo motivo do SSOT tenha prosa.
 */

describe("vocabulário de noOddsReason", () => {
  it("todo motivo do SSOT tem prosa PT-BR própria", () => {
    for (const [motivo, spec] of Object.entries(NO_ODDS_REASONS)) {
      expect(spec.label.trim(), motivo).not.toBe("");
      // Rótulo que repete o slug é o fallback disfarçado de tradução.
      expect(spec.label, motivo).not.toBe(motivo);
      expect(noOddsReasonLabel(motivo)).toBe(spec.label);
    }
  });

  it("a denylist de permanentes é derivada, e o desconhecido re-tenta", () => {
    // A lista sai da tabela, não é digitada à parte: ela decide quais apostas
    // o revive volta a caçar. Sem preço de entrada, motivo do lado da ENTRADA
    // não tem o que re-caçar e não aparece aqui.
    expect([...PERMANENT_NO_ODDS_REASONS].sort()).toEqual([
      "ambiguous_selection",
      // Entrada ao vivo nunca vira pré-jogo: a odd de fechamento pode até
      // existir (a BridgeOdds guarda retroativo), mas comparar com ela é
      // inválido. Permanente é o que tira a linha do pool do revival.
      "aposta_ao_vivo",
      "clv_only",
      // Identidade terminal. Permanentes com efeito NULO sobre o revive: a
      // denylist de `PERMANENT_NO_ODDS_REASONS` só governa o ramo
      // MATCHED/MANUAL de `revive.ts` e `reprocess.ts`, e UNMATCHED não passa
      // por nenhum dos dois. Quem já barrava essas apostas é o
      // `terminal_identity` de `classifyEnrichSkip`.
      "evento_sem_formato",
      "identidade_nao_casada",
      "identity_only",
      "missing_line",
      "multipla",
      "sem_referencia_sharp",
      "sharp_off",
      "unsupported_market",
    ]);
    // Denylist, não allowlist: perder linha que apareceria é pior que uma
    // chamada extra ao provider.
    expect(isPermanentNoOddsReason("motivo_de_outra_versao")).toBe(false);
    expect(isPermanentNoOddsReason(null)).toBe(false);
    expect(isPermanentNoOddsReason("no_prices")).toBe(false);
  });

  it("slug desconhecido volta como veio, sem esconder a linha", () => {
    expect(noOddsReasonLabel("slug_que_nao_existe")).toBe("slug_que_nao_existe");
  });
});

describe("o motivo de identidade terminal é explicado", () => {
  it("o motivo da identidade não casada existe no vocabulário e é dizível", () => {
    expect(NO_ODDS_REASONS).toHaveProperty("identidade_nao_casada");
    expect(noOddsReasonLabel("identidade_nao_casada")).not.toBe("identidade_nao_casada");
    expect(noOddsReasonLabel("evento_sem_formato")).not.toBe("evento_sem_formato");
  });

  it("identidade não casada fica na base, não é “não se aplica”", () => {
    // Some do denominador = a métrica esconde exatamente a conta que decide
    // comprar cobertura de identidade. É o erro que `base` existe para evitar.
    expect(foraDaBaseDeCobertura("identidade_nao_casada")).toBe(false);
    expect(foraDaBaseDeCobertura("evento_sem_formato")).toBe(false);
  });

  it("é permanente — re-caçar odd de identidade não casada só gasta provider", () => {
    expect(isPermanentNoOddsReason("identidade_nao_casada")).toBe(true);
  });

  it("não se confunde com unsupported_market, que é a modalidade sem cobertura", () => {
    // Os dois são do fornecedor, mas compram coisas diferentes: um compra cobertura de
    // identidade, o outro compra cobertura de mercado. Fundi-los apagaria a
    // decisão que o número existe para informar.
    expect(NO_ODDS_REASONS.identidade_nao_casada.label)
      .not.toBe(NO_ODDS_REASONS.unsupported_market.label);
  });
});

describe("missingClvReason: o motivo do CLV que falta, pela tabela certa", () => {
  const frozen = new Date("2026-09-20T20:00:00Z");
  it("CLV confiável congelado não tem motivo, mesmo com motivo velho na identidade", () => {
    expect(missingClvReason({ clvReliable: true, closingFetchedAt: frozen, noOddsReason: "no_prices", closingNoOddsReason: null }))
      .toBeNull();
  });
  it("o motivo do fechamento vence o da identidade", () => {
    expect(missingClvReason({ clvReliable: false, closingFetchedAt: frozen, noOddsReason: "no_prices", closingNoOddsReason: "kickoff_sem_captura" }))
      .toBe("kickoff_sem_captura");
  });
  it("o da identidade só vale quando a ausência alcança o fechamento", () => {
    expect(missingClvReason({ clvReliable: null, closingFetchedAt: null, noOddsReason: "clv_only", closingNoOddsReason: null }))
      .toBeNull();
    expect(missingClvReason({ clvReliable: null, closingFetchedAt: null, noOddsReason: "unsupported_market", closingNoOddsReason: null }))
      .toBe("unsupported_market");
  });
});

describe("de quem é a ausência: fornecedor, sistema ou não se aplica", () => {
  it("a captura que faltou é conserto nosso; a linha que a fonte não tem é do fornecedor", () => {
    expect(noOddsReasonBase("kickoff_sem_captura")).toBe("sistema");
    expect(noOddsReasonBase("closing_quote_too_early")).toBe("sistema");
    expect(noOddsReasonBase("missing_line")).toBe("sistema");
    expect(noOddsReasonBase("market_not_listed")).toBe("fornecedor");
    expect(noOddsReasonBase("line_mismatch")).toBe("fornecedor");
    expect(noOddsReasonBase("unsupported_market")).toBe("fornecedor");
    expect(noOddsReasonBase("aposta_ao_vivo")).toBe("nao_se_aplica");
    expect(noOddsReasonBase("sharp_off")).toBe("nao_se_aplica");
  });

  it("consulta à Pinnacle17 que falhou ou sem cota não conta como linha ausente no fornecedor", () => {
    for (const motivo of ["consulta_pinnacle_falhou", "cota_pinnacle_esgotada"]) {
      expect(noOddsReasonBase(motivo), motivo).toBe("sistema");
      expect(isPermanentNoOddsReason(motivo), motivo).toBe(false);
      // O fechamento consulta de novo: a falha da entrada não explica o CLV que falta.
      expect(missingClvReason({ clvReliable: null, closingFetchedAt: null, noOddsReason: motivo, closingNoOddsReason: null }))
        .toBeNull();
    }
  });

  it("motivo desconhecido é conserto nosso — o vocabulário é que não o conhece", () => {
    expect(noOddsReasonBase("motivo_de_outra_versao")).toBe("sistema");
    expect(SUPPLIER_NO_ODDS_REASONS).not.toContain("motivo_de_outra_versao");
  });

  it("a lista do fornecedor é derivada da tabela", () => {
    const esperada = Object.entries(NO_ODDS_REASONS)
      .flatMap(([motivo, spec]) => (spec.base === "fornecedor" ? [motivo] : []));
    expect([...SUPPLIER_NO_ODDS_REASONS].sort()).toEqual(esperada.sort());
    expect(SUPPLIER_NO_ODDS_REASONS).not.toContain("kickoff_sem_captura");
  });

  it("os motivos da abertura têm prosa e base, e nenhum é permanente", () => {
    for (const motivo of ["partida_nao_localizada", "sem_abertura_na_linha", "falha_na_consulta"]) {
      expect(noOddsReasonLabel(motivo), motivo).not.toBe(motivo);
      expect(isPermanentNoOddsReason(motivo), motivo).toBe(false);
    }
    expect(noOddsReasonBase("partida_nao_localizada")).toBe("fornecedor");
    expect(noOddsReasonBase("falha_na_consulta")).toBe("sistema");
  });

  it("odd de entrada inválida saiu: nenhum código grava esse motivo", () => {
    expect(NO_ODDS_REASONS).not.toHaveProperty("invalid_entry_odds");
  });
});
