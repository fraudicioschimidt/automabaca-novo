import { getBankrollsData } from "@/app/_design/adapters/bankrolls";
import { DesignScreen } from "@/app/_design/DesignScreen";
import { BankrollsScreen } from "@/app/_design/screens/BankrollsScreen";
import { themeMode } from "@/app/_lib/theme-mode";
import { mockFixture } from "@/app/(painel)/_mock";

export const dynamic = "force-dynamic";

/**
 * Bankrolls — `BankrollsScreen`. `?mock=1`
 * usa o dado do design (p/ comparar com o protótipo); sem isso, dado real via
 * adaptador (cada bankroll = um tipster; decisão de assinatura real).
 */
export default async function BankrollsPage({
  searchParams,
}: {
  searchParams: Promise<{ mock?: string }>;
}) {
  const [sp, mode] = await Promise.all([searchParams, themeMode()]);
  const fixture = await mockFixture(sp.mock, () => import("@/app/_design/mock/dashboard"));
  const data = fixture ? fixture.BANKROLLS_TIP : await getBankrollsData();
  return <DesignScreen initialMode={mode}><BankrollsScreen data={data} /></DesignScreen>;
}
