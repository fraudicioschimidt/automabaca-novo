/**
 * As abas de seção de Monitoramento e Config, e o que o número de cada uma
 * CONTA. As filas de Operações são os próprios cartões de resumo (`QueueTabs`).
 *
 * `Liquidar 1` é trabalho parado esperando o operador; `Times 650` é
 * inventário, e ninguém precisa fazer nada com ele. Por isso `tipo` é
 * obrigatório no descritor: aba nova não compila sem declarar o que o número
 * significa (`"sem-contagem"` é declaração explícita). `formaDoContador` é a
 * única porta entre o significado e o desenho, e inventário nunca alcança o
 * token de atenção (`tests/painel/segmentos-de-secao.test.ts`).
 */

import { contagem } from "./plural";

/**
 * O que o número de uma aba conta.
 *
 * - `fila` — trabalho parado esperando o operador. Zero é uma boa notícia e
 *   merece ser dita ("✓"), porque significa "esta fila está em dia".
 * - `inventario` — quantos itens existem. Não há ação pendente, então também
 *   não há estado "resolvido": zero bancas é `0`, nunca um ✓.
 * - `sem-contagem` — a seção não tem número. Declarado, não omitido.
 */
export type TipoDeContador = "fila" | "inventario" | "sem-contagem";

/**
 * A segunda linha do cartão da aba: quem tem número diz a unidade dele ("10
 * abertos"); quem não tem diz o que a seção mostra. Um dos dois é obrigatório.
 */
export type Segmento = {
  readonly id: string;
  readonly rotulo: string;
} & (
  | { readonly tipo: "fila" | "inventario"; readonly unidade: readonly [singular: string, plural: string] }
  | { readonly tipo: "sem-contagem"; readonly descricao: string }
);

/**
 * Seções do Monitoramento.
 *
 * "Manutenção" é a última e não tem contador de propósito: fila morta e lacuna
 * de cobertura de provider são insumo de quem conserta, não decisão do dono. A
 * aba continua existindo porque o replay de job só existe aqui (a ação
 * `dlq.replay` da Caixa de ações marca estado, não reprocessa).
 */
export const SEGMENTOS_DO_MONITORAMENTO = [
  { id: "incidentes", rotulo: "Incidentes", tipo: "fila", unidade: ["aberto", "abertos"] },
  { id: "desempenho", rotulo: "Desempenho", tipo: "fila", unidade: ["alerta", "alertas"] },
  { id: "ocr", rotulo: "Modelos de OCR", tipo: "sem-contagem", descricao: "leitura de imagens" },
  { id: "providers", rotulo: "Providers", tipo: "sem-contagem", descricao: "gasto e cotas" },
  { id: "canais", rotulo: "Canais", tipo: "fila", unidade: ["degradado", "degradados"] },
  { id: "manutencao", rotulo: "Manutenção", tipo: "sem-contagem", descricao: "falhas e replay" },
] as const satisfies readonly Segmento[];

/**
 * Seções de Config, o lado do INVENTÁRIO: bancas e times são cadastro, e o
 * número diz o tamanho do acervo, não que exista trabalho parado.
 */
export const SEGMENTOS_DE_CONFIG = [
  { id: "bancas", rotulo: "Tipsters", tipo: "inventario", unidade: ["cadastrado", "cadastrados"] },
  { id: "mercados", rotulo: "Mercados", tipo: "sem-contagem", descricao: "taxonomia" },
  { id: "times", rotulo: "Times", tipo: "inventario", unidade: ["time", "times"] },
  { id: "jogadores", rotulo: "Jogadores", tipo: "sem-contagem", descricao: "identidades" },
  { id: "seguranca", rotulo: "Segurança", tipo: "sem-contagem", descricao: "sessões e acesso" },
] as const satisfies readonly Segmento[];

/**
 * Como o contador se DESENHA. Uma forma por significado — a tela não escolhe
 * token, ela lê daqui.
 *
 * - `atencao` — legenda na cor de destaque. Presente sem gritar.
 * - `resolvido` — "em dia" em verde: a fila existe e está zerada.
 * - `inventario` — contagem terciária do acervo. Nunca "em dia".
 * - `ausente` — não desenha nada.
 */
export type FormaDoContador = "atencao" | "resolvido" | "inventario" | "ausente";

/**
 * Viés fail-closed: número sem tipo declarado (ou tipo `sem-contagem`) NÃO
 * desenha. Sumir é melhor que virar alarme falso.
 */
export function formaDoContador(tipo: TipoDeContador, n: number | null | undefined): FormaDoContador {
  if (tipo === "sem-contagem") return "ausente";
  if (typeof n !== "number" || !Number.isFinite(n)) return "ausente";
  if (tipo === "inventario") return "inventario";
  return n > 0 ? "atencao" : "resolvido";
}

/**
 * A segunda linha do cartão: "10 abertos", "em dia" na fila zerada, "650
 * aliases" no acervo, ou a descrição da seção sem número. Sem leitura do
 * número, "sem leitura": nunca um zero inventado. É o mesmo texto para quem vê
 * e para quem ouve, e a unidade diz se o número é pendência ou acervo.
 */
export function legendaDoSegmento(segmento: Segmento, n: number | null | undefined): string {
  if (segmento.tipo === "sem-contagem") return segmento.descricao;
  const forma = formaDoContador(segmento.tipo, n);
  if (forma === "ausente") return "sem leitura";
  if (forma === "resolvido") return "em dia";
  const [singular, plural] = segmento.unidade;
  return contagem(n as number, singular, plural);
}
