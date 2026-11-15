import { getToolsData } from "@/app/_design/adapters/tools";
import { DesignScreen } from "@/app/_design/DesignScreen";
import { FerramentasScreen } from "@/app/_design/screens/FerramentasScreen";
import { themeMode } from "@/app/_lib/theme-mode";
import { mockFixture } from "@/app/(painel)/_mock";

export const dynamic = "force-dynamic";

/**
 * Ferramentas — calculadora Kelly. `?mock=1` usa os dados de demonstração;
 * sem isso, o CLV médio REAL do canal via adaptador.
 */
export default async function FerramentasPage({
  searchParams,
}: {
  searchParams: Promise<{ mock?: string; bankroll?: string }>;
}) {
  const sp = await searchParams;
  const [data, mode] = await Promise.all([
    mockFixture(sp.mock, () => import("@/app/_design/mock/tools"))
      .then((fixture) => fixture ? fixture.TOOLS : getToolsData(sp.bankroll)),
    themeMode(),
  ]);
  return <DesignScreen initialMode={mode}><FerramentasScreen data={data} /></DesignScreen>;
}
