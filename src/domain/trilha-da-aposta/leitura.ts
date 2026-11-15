/**
 * Como ler o `details` cru com segurança — e os rótulos em PT.
 *
 * A fronteira com o `index`: aqui mora "extrair valor de um Json sem forma
 * garantida"; lá mora "que frase cada evento vira". Nenhuma função daqui
 * conhece tipo de evento, e nenhuma de lá toca em `unknown`.
 *
 * Todo leitor é TOTAL: qualquer entrada devolve string, nunca lança e nunca
 * deixa `undefined` chegar à tela. É o que dispensa Zod aqui — o `details` é
 * escrita nossa, não saída de LLM (essa, sim, exige validação) —, e o portão
 * prova a totalidade passando `dados: {}` em todos os tipos.
 */

import { parseStoredLegs } from "@/src/domain/bet-legs";
import { formatSpDateTime } from "@/src/domain/dates";
import { fmtOdds } from "@/src/domain/formato-de-resultado";
import { actorDisplayName } from "@/src/domain/production-write-actors";
import { rotuloDeStatus } from "@/src/domain/status-de-aposta";
import { captureOriginLabel } from "@/src/domain/telegram-source";
import type { MudancaDeCampo } from "./tipos";

/** O travessão único do módulo — ausência tem UMA grafia. */
export const VAZIO = "—";

/** Lê um campo de `dados` sem confiar no formato — Json? não tem forma garantida. */
export function texto(dados: Record<string, unknown>, campo: string): string {
  const v = dados[campo];
  if (v == null || v === "") return VAZIO;
  return String(v);
}

export function numero(dados: Record<string, unknown>, campo: string): number | null {
  const v = dados[campo];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function objeto(dados: Record<string, unknown>, campo: string): Record<string, unknown> {
  const v = dados[campo];
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * Status do domínio → PT, mas HONESTO: `rotuloDeStatus` manda desconhecido para
 * "reembolso" de propósito (pintar neutro nunca inventa ganho ou perda), e essa
 * é a escolha certa para COR. Em prosa ela mente: "liquidada como reembolso"
 * afirma um resultado que ninguém apurou. Aqui o desconhecido se declara.
 */
const STATUS_CONHECIDOS = new Set([
  "PENDING", "WON", "HALF_WON", "LOST", "HALF_LOST", "CASHOUT", "VOID", "CANCELED",
]);

export function statusEmProsa(dados: Record<string, unknown>, campo: string): string {
  const bruto = dados[campo];
  if (typeof bruto !== "string" || bruto === "") return VAZIO;
  return STATUS_CONHECIDOS.has(bruto) ? rotuloDeStatus(bruto) : `status desconhecido (${bruto})`;
}

/** De onde chegou uma aposta: a origem e, quando há, a mensagem e o item do lote. */
export function origemDoPost(dados: Record<string, unknown>): string {
  const origem = captureOriginLabel(texto(dados, "source"));
  const externo = dados["sourceExternalId"];
  if (typeof externo !== "string" || externo === "") return origem;
  const [mensagem, item] = externo.split(":");
  return `${origem}, mensagem ${mensagem}${item ? `, item ${item}` : ""}`;
}

/** Instante ISO → "12/08 16:00" no fuso SP, ou "—" se não der para ler. */
function formatarInstante(v: unknown): string {
  if (typeof v !== "string") return VAZIO;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? VAZIO : formatSpDateTime(d);
}

export function instante(dados: Record<string, unknown>, campo: string): string {
  return formatarInstante(dados[campo]);
}

/**
 * Quem originou a captura, em prosa. O `actor` vem como
 * `telegram-channel:gemini-vision` — o sufixo é o EXTRATOR, não o canal.
 */
export function origemDaCaptura(ator: string): string {
  const [prefixo, ...resto] = ator.split(":");
  if (prefixo === "telegram-channel") {
    const extrator = resto.join(":");
    return extrator ? `canal do Telegram (${extrator})` : "canal do Telegram";
  }
  return ator || VAZIO;
}

/**
 * Fonte da liquidação em PT. O vocabulário é ABERTO no banco (`flashscore`,
 * `score`, `ia-judge:*` e grafias ad-hoc sob `manual:`), então a regra é não
 * deixar string crua vazar para a tela: `manual:*` vira prosa com o sufixo
 * preservado, e o que não casar é nomeado como desconhecido em vez de sumir.
 */
export function rotuloDaFonteDeLiquidacao(source: string | null | undefined): string {
  if (!source) return "fonte não registrada";
  if (source === "flashscore") return "liquidação automática pelo FlashScore";
  if (source === "score") return "conferência de placar";
  if (source.startsWith("manual:")) {
    const sufixo = source.slice("manual:".length);
    return sufixo ? `ação manual (${sufixo})` : "ação manual";
  }
  if (source.startsWith("ia-judge:")) {
    const sufixo = source.slice("ia-judge:".length);
    if (sufixo === "ia_judge_auto") return "IA-Judge automático";
    return sufixo ? `IA-Judge (${actorDisplayName(sufixo)})` : "IA-Judge";
  }
  return `fonte desconhecida (${source})`;
}

/** Campos de `antes`/`depois` que valem uma linha de diff, com o nome em PT. */
const CAMPOS_DE_DIFF: ReadonlyArray<readonly [string, string]> = [
  ["evento", "evento"],
  ["data", "início do jogo"],
  ["kickoffInferido", "horário a confirmar"],
  ["esporte", "esporte"],
  ["pais", "país"],
  ["competicao", "campeonato"],
  ["mercado", "mercado"],
  ["selecao", "seleção"],
  ["odds", "odd"],
  ["stake", "stake"],
  ["casaDeAposta", "casa"],
  ["contaId", "conta"],
  ["legsJson", "pernas da múltipla"],
  ["sportResolutionStatus", "confirmação do esporte"],
  ["liveScoreHome", "placar (casa)"],
  ["liveScoreAway", "placar (visitante)"],
  ["sportSource", "origem do esporte"],
  ["sportConfidence", "confiança do esporte"],
];

export function valorDeDiff(campo: string, valor: unknown): string {
  if (valor == null || valor === "") return VAZIO;
  if (campo === "odds" && typeof valor === "number") return fmtOdds(valor);
  if (campo === "data") return formatarInstante(valor);
  if (campo === "sportResolutionStatus") {
    const labels: Record<string, string> = { CONFIRMED: "confirmado", PENDING: "pendente", CONFLICT: "em conflito" };
    return labels[String(valor)] ?? String(valor);
  }
  if (campo === "legsJson") {
    const ticket = parseStoredLegs(valor);
    if (!ticket) return "bilhete não reconhecido";
    const kind = ticket.kind === "same_game" ? "mesmo jogo" : "jogos diferentes";
    return `${kind}: ${ticket.legs.map((leg) => `${leg.evento} — ${leg.mercado} — ${leg.selecao}`).join("; ")}`;
  }
  if (typeof valor === "boolean") return valor ? "sim" : "não";
  return String(valor);
}

/** As diferenças entre `antes` e `depois`, só dos campos que mudaram. */
export function diff(dados: Record<string, unknown>): MudancaDeCampo[] {
  const antes = objeto(dados, "antes");
  const depois = objeto(dados, "depois");
  const out: MudancaDeCampo[] = [];
  for (const [chave, rotulo] of CAMPOS_DE_DIFF) {
    if (!(chave in antes) && !(chave in depois)) continue;
    const de = valorDeDiff(chave, antes[chave]);
    const para = valorDeDiff(chave, depois[chave]);
    if (de !== para) out.push({ campo: rotulo, de, para });
  }
  return out;
}
