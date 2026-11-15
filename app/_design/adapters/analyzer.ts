import "server-only";
import { spDayKey } from "@/src/domain/dates";
import { getBankrollBySlug } from "@/src/services/painel/queries/bankrolls";
import { readAnalyzer } from "@/src/services/painel/queries/analyzer";
import { parseAnalyzerQuery, type AnalyzerQuery } from "@/src/domain/analyzer-query";
import { packAnalyzerBet } from "@/app/_design/lib/analyzer-pack";
import { getFrescorDosDados } from "@/src/services/painel/frescor";
import { resolveLogoUrl } from "@/src/services/painel/logos";

/**
 * Recorte atual e anterior, ou agregado completo paginado para históricos
 * extensos. `slug` nulo é a carteira: todas as bancas, com o dinheiro em reais.
 */
export async function getAnalyzerData(slug: string | null, query: AnalyzerQuery = parseAnalyzerQuery()) {
  const bk = slug === null ? null : await getBankrollBySlug(slug);
  if (slug !== null && !bk) return null;
  const today = spDayKey(new Date());
  const [{ rows, largeHistory }, frescor] = await Promise.all([
    readAnalyzer(bk?.id ?? null, query, today),
    getFrescorDosDados(bk?.id ?? null),
  ]);
  const bets = rows.map((b) => packAnalyzerBet(b, spDayKey(b.data)));
  return {
    scope: bk ? "bankroll" as const : "portfolio" as const,
    query,
    largeHistory: largeHistory ? {
      ...largeHistory,
      firstDay: largeHistory.firstDate ? spDayKey(largeHistory.firstDate) : null,
      lastDay: largeHistory.lastDate ? spDayKey(largeHistory.lastDate) : null,
      rows: largeHistory.rows.map((row) => packAnalyzerBet(row, spDayKey(row.data))),
    } : null,
    bets,
    frescor: [frescor.captura, frescor.fechamento],
    bk: bk ? {
      name: bk.nome,
      logoUrl: resolveLogoUrl(bk.slug, bk.id),
      slug: bk.slug as string | null,
    } : { name: "Carteira", logoUrl: null, slug: null },
    today,
  };
}
