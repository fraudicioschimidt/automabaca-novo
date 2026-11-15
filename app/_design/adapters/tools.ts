import "server-only";
import { AMOSTRA_MINIMA_CLV, VEREDITO_NA_TELA } from "@/src/domain/analyzer/shared";
import { getBankrollsTips } from "@/src/services/painel/queries/bankrolls";
import { getCanaisDecisao } from "@/src/services/painel/canais";

/**
 * Dados da tela Ferramentas (calculadora Kelly). A vantagem sugerida é o CLV
 * médio do canal na MESMA régua da tela de Bancas (`getCanaisDecisao`): outra
 * conta daria ao Kelly um CLV que Bancas não mostra.
 * Sem id: usa a primeira banca por nome.
 */
export async function getToolsData(bankrollIdOrSlug?: string) {
  const bankrolls = await getBankrollsTips();
  const selected =
    (bankrollIdOrSlug
      ? bankrolls.find((b) => b.id === bankrollIdOrSlug || b.slug === bankrollIdOrSlug)
      : null) ?? bankrolls[0] ?? null;

  const decisao = selected ? (await getCanaisDecisao(new Date(), { bankrollId: selected.id }))[0]?.decisao : undefined;
  const clvCanal = selected && decisao && decisao.clvMedio !== null && decisao.nClv > 0
    ? {
        nome: selected.nome,
        media: decisao.clvMedio,
        n: decisao.nClv,
        verdict: VEREDITO_NA_TELA[decisao.veredito],
        // Abaixo da amostra mínima o CLV médio é ruído: a tela mostra, mas não
        // o oferece como vantagem.
        faltam: Math.max(0, AMOSTRA_MINIMA_CLV - decisao.nClv),
      }
    : null;
  return {
    bankrolls: bankrolls.map((b) => ({ id: b.id, slug: b.slug, nome: b.nome })),
    selectedBankrollId: selected?.id ?? null,
    selectedBankrollNome: selected?.nome ?? null,
    clvCanal,
  };
}
