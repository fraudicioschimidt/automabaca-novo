import type { DestaqueDeTaxa } from "./tipster-metrics";
import { contagem } from "./plural";

/**
 * A base do destaque de taxa, por extenso — sob o percentual, nunca só a cor.
 *
 * Três estados, três frases: quem venceu diz sobre quantos fechamentos venceu;
 * ninguém elegível NÃO é o mesmo que ninguém medido. Colapsar os dois em "—"
 * esconderia o que decide entre esperar mais amostra e investigar por que não
 * há fechamento nenhum.
 */
export function textoDaBaseDoDestaque(destaque: DestaqueDeTaxa<unknown>): string | null {
  if (destaque.estado === "ok") return contagem(destaque.amostra, "fechamento");
  if (destaque.estado === "amostra-curta") {
    return `amostra curta · máx. ${contagem(destaque.melhorAmostra, "fechamento")}`;
  }
  return "sem fechamento medido";
}
