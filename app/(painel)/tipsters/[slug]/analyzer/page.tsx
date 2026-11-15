import { themeMode } from "@/app/_lib/theme-mode";
import { notFound } from "next/navigation";
import { getAnalyzerData } from "@/app/_design/adapters/analyzer";
import { AnalyzerClient } from "@/app/(painel)/analyzer/AnalyzerClient";
import { mockFixture } from "@/app/(painel)/_mock";
import { parseAnalyzerQuery } from "@/src/domain/analyzer-query";

export const dynamic = "force-dynamic";

/**
 * Analyzer — `AnalyzerScreen`. `?mock=1` serve
 * o dado do design (histórico sintético); sem isso, o histórico REAL da banca,
 * agregado pelo analyzer/* TESTADO via shim client. `?bk=` só vale no mock.
 */
export default async function AnalyzerPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ bk?: string; mock?: string; periodo?: string; esporte?: string; casa?: string; pagina?: string }>;
}) {
  const [{ slug }, sp, mode] = await Promise.all([params, searchParams, themeMode()]);
  const path = `/tipsters/${encodeURIComponent(slug)}/analyzer`;
  const fixture = await mockFixture(sp.mock, () => import("@/app/_design/mock/analyzer-data"));
  if (fixture) {
    const { ANALYZER_MOCK_DATA } = fixture;
    return <AnalyzerClient path={path} slug={slug} bkId={sp.bk ?? null} data={ANALYZER_MOCK_DATA} initialMode={mode} />;
  }
  const data = await getAnalyzerData(slug, parseAnalyzerQuery(sp));
  if (!data) notFound();
  return <AnalyzerClient path={path} slug={slug} bkId={null} data={data} initialMode={mode} />;
}
