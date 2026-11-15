import { describe, expect, it } from "vitest";
import { hasSportScoreUnitMismatch } from "@/src/domain/mercados/stat-qualifier";
import { MERCADO_TRANSLATIONS } from "@/src/domain/mercados/catalog";
import { isMercadoFinalForSport } from "@/src/domain/mercados/compatibility";
import { pinnacleizeMercado } from "@/src/domain/mercados/finalize";
import { normalizeMercado } from "@/src/services/mercados/normalize";
import { productionMarketCatalogClient } from "../fixtures/mercados-alias-producao";

/**
 * Traduções sem alias no catálogo que ficam fora da captura de propósito.
 * Rounds de eSports não são mapas: levá-los ao handicap/total do jogo
 * liquidaria pela unidade errada. "Handicap de Pontos" é o Point Spread do
 * catálogo, que não existe no futebol nem no hóquei.
 */
const TRANSLATIONS_OUTSIDE_CAPTURE: Readonly<Record<string, readonly string[] | "all">> = {
  "Handicap de Rounds da Partida": "all",
  "Handicap de Rounds": "all",
  "Total de Rounds da Partida": "all",
  "Total de Rounds": "all",
  "Handicap de Pontos": ["Soccer", "Hockey"],
};

function outsideCapture(key: string, esporte: string): boolean {
  const sports = TRANSLATIONS_OUTSIDE_CAPTURE[key];
  return sports === "all" || (sports?.includes(esporte) ?? false);
}

/**
 * Depois do seed o banco governa e a tradução estática não entra mais: toda
 * tradução que leva a um mercado final do esporte precisa de alias no
 * catálogo, senão a captura grava o rótulo cru ("⚠️ Mercado não reconhecido").
 */
describe("normalizeMercado com o catálogo de produção", () => {
  const client = productionMarketCatalogClient();

  it.each(["Soccer", "Basketball", "Hockey"])("reconhece toda tradução estática que tem mercado final (%s)", async (esporte) => {
    const missing: string[] = [];
    for (const key of Object.keys(MERCADO_TRANSLATIONS)) {
      if (hasSportScoreUnitMismatch(key, "", esporte)) {
        await expect(normalizeMercado(key, { esporte, client })).resolves.toEqual({ mercado: key, matched: false });
        continue;
      }
      const expected = pinnacleizeMercado(key, esporte);
      if (!isMercadoFinalForSport(expected, esporte) || outsideCapture(key, esporte)) continue;
      const result = await normalizeMercado(key, { esporte, client });
      if (!result.matched || result.mercado !== expected) missing.push(`${key} → ${result.mercado} (esperado ${expected})`);
    }
    expect(missing).toEqual([]);
  });

  it.each([
    ["Total de Gols", "Soccer", "Total – Match"],
    ["Handicap da Partida", "Soccer", "Handicap – Match"],
    ["Handicap - 2 Opções", "Basketball", "Handicap – Game"],
    ["Asian Handicap (Bookings) – Match", "Soccer", "Handicap (Bookings) – Match"],
  ])("%s (%s) grava %s", async (raw, esporte, expected) => {
    await expect(normalizeMercado(raw, { esporte, client })).resolves.toEqual({ mercado: expected, matched: true });
  });

  it.each(["Total de Gols", "Gols Mais/Menos", "Gols"])(
    "%s com o esporte ainda desconhecido normaliza; só o esporte conhecido sem gols conserva o rótulo",
    async (raw) => {
      expect((await normalizeMercado(raw, { esporte: "Unknown", client })).mercado).toBe("Total – Match");
      await expect(normalizeMercado(raw, { esporte: "Basketball", client })).resolves.toEqual({ mercado: raw, matched: false });
    },
  );
});
