import { describe, expect, it } from "vitest";
import {
  NO_ODDS_REASONS,
  ausenciaAlcancaFechamento,
  fechamentoConfirmado,
} from "@/src/domain/no-odds-reason";
import { computeSteamV1 } from "@/src/domain/analyzer/steam";
import type { BetRowData } from "@/src/domain/bet-read-model";

/**
 * Portão: número exibido como "fechamento" numa linha que não tem fechamento.
 *
 * `writeClosingOnce` documenta `fetchedAt` como "já tentou congelar CLV
 * (**mesmo sem odd**)". Quem congela SEM odd (a guarda de entrada ao vivo, em
 * três caminhos) deixa no lugar a linha provisória que `upsertProvisional`
 * escreveu antes do kickoff, então `closingFetchedAt != null` sozinho não prova
 * fechamento.
 *
 * Não é só exibição: a fantasma entra na base "entrada → fechamento" de
 * `computeSteamV1` e pode inverter o SINAL da métrica que responde "eu bato o
 * fechamento?". O CLV escapa porque exige `clvReliable`, e é isso que torna o
 * defeito difícil de ver: a métrica mais vigiada fica certa e as vizinhas mentem.
 */

function bet(over: Partial<BetRowData> = {}): BetRowData {
  return {
    id: "b1",
    data: new Date("2026-08-10T18:00:00Z"),
    registradoEm: new Date("2026-08-10T17:00:00Z"),
    evento: "A vs B",
    status: "WON",
    odds: 1.77,
    stake: 1,
    lucro: 0.77,
    openingRawOdd: 1.8,
    closingRawOdd: 3.86,
    closingOdd: 3.857,
    closingFetchedAt: new Date("2026-08-10T18:00:00Z"),
    closingNoOddsReason: null,
    clvReliable: null,
    clv: null,
    ...over,
  } as unknown as BetRowData;
}

describe("fechamento só existe quando a linha o confirma", () => {
  it("congelado SEM odd não vira fechamento", () => {
    // `fetchedAt` setado pela guarda de entrada ao vivo, provisória sobrando.
    expect(fechamentoConfirmado({
      closingFetchedAt: new Date("2026-08-10T18:00:00Z"),
      closingNoOddsReason: "aposta_ao_vivo",
    })).toBe(false);
  });

  it("congelado e sem motivo é fechamento de verdade", () => {
    expect(fechamentoConfirmado({
      closingFetchedAt: new Date("2026-08-10T18:00:00Z"),
      closingNoOddsReason: null,
    })).toBe(true);
  });

  it("não congelado nunca é fechamento, com ou sem motivo", () => {
    expect(fechamentoConfirmado({ closingFetchedAt: null, closingNoOddsReason: null })).toBe(false);
  });

  /**
   * A ASSIMETRIA de que a regra depende. O motivo mora em três tabelas e nem
   * sempre fala da tabela onde está: `clv_only` fala da odd de ENTRADA, e os
   * motivos só da ABERTURA não dizem nada do fechamento. Esconder o fechamento
   * por causa deles trocaria um bug por outro — o preço de fechamento existe e
   * é utilizável.
   */
  it("motivo do lado da ENTRADA ou da ABERTURA não apaga um fechamento válido", () => {
    for (const motivo of ["clv_only", "sem_abertura_na_linha", "falha_na_consulta"]) {
      expect(ausenciaAlcancaFechamento(motivo), motivo).toBe(false);
      expect(fechamentoConfirmado({
        closingFetchedAt: new Date("2026-08-10T18:00:00Z"),
        closingNoOddsReason: motivo,
      }), motivo).toBe(true);
    }
  });

  it("motivo desconhecido NÃO publica — direção oposta à denylist, de propósito", () => {
    // `isPermanentNoOddsReason` erra para o lado de re-tentar, e custa uma
    // chamada. Aqui errar para o lado de publicar custa uma MENTIRA na tela.
    expect(ausenciaAlcancaFechamento("motivo_de_outra_versao")).toBe(true);
  });

  it("todo motivo do SSOT declara de que lado a odd falta", () => {
    const semLado = Object.entries(NO_ODDS_REASONS)
      .filter(([, spec]) => !["entrada", "abertura", "fechamento", "ambos"].includes(spec.ausencia))
      .map(([nome]) => nome);
    expect(semLado, "motivo novo nasce declarando `ausencia`").toEqual([]);
    // Se um dia nenhum motivo for de fechamento, este portão virou decoração.
    const lados = new Set(Object.values(NO_ODDS_REASONS).map((s) => s.ausencia));
    expect(lados.has("fechamento")).toBe(true);
    expect(lados.has("entrada")).toBe(true);
  });
});

describe("o analyzer não mede movimento contra linha provisória", () => {
  it("a fantasma sai da base de entrada→fechamento e do price path", () => {
    const legitima = bet({ id: "ok", odds: 2.2, closingRawOdd: 2.0 });
    const fantasma = bet({
      id: "fantasma",
      odds: 1.77,
      closingRawOdd: 3.86,
      closingNoOddsReason: "aposta_ao_vivo",
    } as Partial<BetRowData>);

    const steam = computeSteamV1([legitima, fantasma]);

    expect(steam.withClosing, "a provisória entrou na base").toBe(1);
    // Só a legítima: +10% (2.2 contra 2.0). Com a fantasma a média cai para
    // -17.7% e o sinal inverte.
    expect(steam.avgEntryToClosing).toBeCloseTo(10, 5);
    const caminho = steam.pricePaths.find((p) => p.evento === "A vs B" && p.taken === 1.77);
    expect(caminho?.closing, "price path desenhou o movimento fantasma").toBeNull();
  });
});
