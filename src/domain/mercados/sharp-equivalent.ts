/**
 * O mercado equivalente que os feeds cotam quando o original não existe neles
 * (DNB → AH 0.0, Dupla Chance 1X/X2 → AH +0.5). A regra mora em Rust
 * (`rust/crates/dominio/src/mercados/sharp_equivalent.rs`).
 */
import dominio from "@automabaca/dominio";

type SharpEquivalentBet = {
  mercado: string;
  selecao: string;
  nota: "dnb→ah_0.0" | "dc→ah_+0.5";
};

/**
 * Esporte não informado conta como compatível; `null` vindo do banco não (o
 * Rust lê o vazio como esporte desconhecido, como o TS lia o `null`).
 */
function sport(esporte: string | undefined): string | undefined {
  return esporte === undefined ? undefined : (esporte ?? "");
}

/** Sem esporte confirmado ou com regras distintas de retirada, não há equivalência comprovada. */
export function supportsSharpEquivalence(esporte?: string): boolean {
  return dominio.supportsSharpEquivalence(sport(esporte));
}

/**
 * Tradução para o mercado equivalente quotável quando o original não existe
 * nos feeds. Null = sem equivalente (segue o fluxo normal).
 */
export function sharpEquivalentBet(params: {
  mercado: string;
  selecao: string;
  evento: string;
  esporte?: string;
}): SharpEquivalentBet | null {
  const bet = dominio.sharpEquivalentBet(params.mercado, params.selecao, params.evento, sport(params.esporte));
  return bet && { mercado: bet[0], selecao: bet[1], nota: bet[2] };
}

/** Aposta efetiva para PRECIFICAÇÃO: original, ou o equivalente AH. */
export function effectiveSharpBet(params: {
  mercado: string;
  selecao: string;
  evento: string;
  esporte?: string;
}): { mercado: string; selecao: string } {
  return sharpEquivalentBet(params) ?? { mercado: params.mercado, selecao: params.selecao };
}
