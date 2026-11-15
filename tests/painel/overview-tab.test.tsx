import { expect, it } from "vitest";
import { OverviewTab } from "@/app/_design/screens/analyzer/overview-tab";
import { testedAnData } from "@/app/_design/lib/tested-analyzer";
import { unpackAnalyzerBets } from "@/app/_design/lib/analyzer-pack";
import { ANALYZER_MOCK_DATA } from "@/app/_design/mock/analyzer-data";
import { renderDesignMarkup } from "../helpers/design-markup";

it.each([
  ["WON", 0.1, "+10.0%", "+5.0 p.p."],
  ["LOST", -1, "-100.0%", "-105.0 p.p."],
])("diferença entre ROI e CLV em %s usa pontos percentuais", (status, lucro, roi, difference) => {
  const source = unpackAnalyzerBets(ANALYZER_MOCK_DATA.bets)[0]!;
  const D = testedAnData.D([{ ...source, status, stake: 1, lucro, odds: 1.1,
    clv: 5, clvReliable: true, closingFetchedAt: new Date("2026-06-10T12:00:00Z"),
  }]);
  const html = renderDesignMarkup(<OverviewTab D={D} periodCard={null} abrirRecorte={() => undefined} anterior={null} emCursoAtual={{ pendentes: 0, total: 1 }} />);
  expect(html).toContain(roi);
  expect(html).toContain("+5.0%");
  expect(html).toContain(difference);
});
