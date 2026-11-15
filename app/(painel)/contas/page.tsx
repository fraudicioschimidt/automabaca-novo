import { themeMode } from "@/app/_lib/theme-mode";
import { getContasData } from "@/app/_design/adapters/contas";
import {
  alterarStatusContaAction,
  criarContaAction,
  editarContaAction,
  movimentarContaAction,
  removerContaAction,
} from "./actions";
import { ContasClient } from "./ContasClient";
import { mockFixture } from "@/app/(painel)/_mock";
import { canManage as sessionCanManage } from "@/app/(painel)/_auth";

export const dynamic = "force-dynamic";

/**
 * Contas — `ContasScreen`. `?mock=1` usa os
 * dados originais do design (p/ comparar 100% com o protótipo) e NÃO passa as
 * actions (botões ficam "em breve" — mutação nunca roda sobre dado fake). Sem
   * isso, dado real via adaptador + mutações de ledger fiéis. `?acc=<id>` abre o
 * detalhe.
 */
export default async function ContasPage({
  searchParams,
}: {
    searchParams: Promise<{ acc?: string; empty?: string; mock?: string }>;
}) {
  const sp = await searchParams;
  const mode = await themeMode();
  const fixture = await mockFixture(sp.mock, () => import("@/app/_design/mock/contas"));
  if (fixture) {
    const { ACC, EMPTY_ACC } = fixture;
    return <ContasClient data={sp.empty === "1" ? EMPTY_ACC : ACC} accId={sp.acc ?? null} initialMode={mode} />;
  }
  const [canManage, data] = await Promise.all([sessionCanManage(), getContasData()]);
  return (
    <ContasClient
      data={data}
      accId={sp.acc ?? null}
      initialMode={mode}
      canManage={canManage}
      onMovimentar={canManage ? movimentarContaAction : undefined}
      onCriar={canManage ? criarContaAction : undefined}
      onEditar={canManage ? editarContaAction : undefined}
      onStatus={canManage ? alterarStatusContaAction : undefined}
      onRemover={canManage ? removerContaAction : undefined}
    />
  );
}
