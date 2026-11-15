import type { BaseDeCobertura } from "@/src/domain/analyzer/cobertura";
import { contagem } from "./plural";

/**
 * Como um percentual de cobertura se escreve, em um lugar só: **o número
 * declara a base**. `cobertura 53%` não diz nada; `97% — 34 de 35 alcançáveis`
 * diz o que foi medido e contra o quê. Dividir pelo conjunto inteiro
 * (`percentOf(x, FB.length)`) conta como falha o que a métrica nem alcança.
 * `tests/painel/analyzer-cobertura.test.ts` impede as telas de montarem a
 * frase por conta própria.
 */
export function textoDeCobertura(c: BaseDeCobertura<unknown>): string {
  if (c.pct == null) return "sem base alcançável no recorte";
  return `${Math.round(c.pct)}% — ${c.cobertas.length} de ${c.base.length} ${
    c.base.length === 1 ? "alcançável" : "alcançáveis"
  }`;
}

/**
 * O que ficou FORA da base, quando há algo a dizer. Frase separada porque nem
 * todo lugar tem largura para ela — o KPI mostra a conta, o cartão mostra o
 * porquê. `null` quando nada foi excluído: escrever "0 fora" é ruído.
 */
export function textoDoQueFicouFora(c: BaseDeCobertura<unknown>): string | null {
  const partes: string[] = [];
  if (c.cedo.length) partes.push(`${contagem(c.cedo.length, "pendente")}`);
  if (c.naoSeAplica.length) partes.push(`${c.naoSeAplica.length} fora do alcance`);
  if (!partes.length) return null;
  return `${partes.join(" e ")} fora da base`;
}
