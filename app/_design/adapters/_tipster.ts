import "server-only";
import { spRelative } from "@/src/domain/dates";
import { fmtBrlPerUnit } from "@/src/domain/formato-de-resultado";
import type { BankrollSummary } from "@/src/services/painel/queries/bankrolls";

/**
 * Campos comuns que cada bankroll vira no "tipster" das telas de design
 * (dashboard e bankrolls); cada tela acrescenta o que é só dela. lucro e stake
 * já estão em unidades; profitBrl/stakedBrl conservam os snapshots em reais
 * para os consolidados.
 */

export function baseTipster(s: BankrollSummary) {
  return {
    id: s.slug, // links das telas (/tipsters/<id>) batem com a rota [slug]
    name: s.nome,
    sharpMode: s.sharpMode, // a tela mostra o selo do modo (SharpModeTag)
    unit: fmtBrlPerUnit(s.valorUnidade),
    n: s.apostas,
    open: s.pendentes,
    resolved: s.resolvidas,
    wins: s.wins,
    losses: s.losses,
    halfWins: s.halfWins,
    halfLosses: s.halfLosses,
    profitBrl: s.profitBrl,
    stakedBrl: s.stakedBrl,
    attempts: s.wins + s.losses,
    lucro: s.lucro,
    roi: s.roi ?? 0,
    clv: s.clv ?? 0,
    clvSamples: s.clvSamples,
    hasRoi: s.roi !== null,
    hasClv: s.clv !== null,
    hasAcerto: s.acerto !== null,
    acerto: s.acerto ?? 0,
    staked: s.stakeFinalizada,
    last: s.ultimaAtividade ? `ativo ${spRelative(s.ultimaAtividade)}` : "sem apostas ainda",
    main: s.slug === "main",
    logoUrl: s.logoUrl, // imagem real do tipster (ou null → a tela usa o monograma)
  };
}
