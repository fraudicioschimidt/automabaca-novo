import { notFound } from "next/navigation";
import { themeMode } from "@/app/_lib/theme-mode";
import { getAnalyzerData } from "@/app/_design/adapters/analyzer";
import { mockFixture } from "@/app/(painel)/_mock";
import { parseAnalyzerQuery } from "@/src/domain/analyzer-query";
import { AnalyzerClient } from "./AnalyzerClient";

export const dynamic = "force-dynamic";

/**
 * Analyzer da carteira: todas as bancas juntas, com o dinheiro em reais pelo
 * valor da unidade de cada aposta e a dimensão Canal nos segmentos. Abre em 90
 * dias: junta o histórico de todas as bancas e chega antes ao teto de detalhe.
 * `?mock=1` serve a carteira sintética do design.
 */
export default async function PortfolioAnalyzerPage({
  searchParams,
}: {
  searchParams: Promise<{ mock?: string; periodo?: string; esporte?: string; casa?: string; pagina?: string }>;
}) {
  const [sp, mode] = await Promise.all([searchParams, themeMode()]);
  const fixture = await mockFixture(sp.mock, () => import("@/app/_design/mock/analyzer-data"));
  if (fixture) {
    return <AnalyzerClient path="/analyzer" slug={null} bkId={null} data={fixture.ANALYZER_PORTFOLIO_MOCK_DATA} initialMode={mode} />;
  }
  const data = await getAnalyzerData(null, parseAnalyzerQuery(sp, "90d"));
  if (!data) notFound();
  return <AnalyzerClient path="/analyzer" slug={null} bkId={null} data={data} initialMode={mode} />;
}
