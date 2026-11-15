/**
 * A leitura de uma ação da Caixa de ações: o texto do produtor é a mensagem do
 * Telegram (emojis de marcação, "👉 próximo passo", URL solta, evidência em
 * JSON). Aqui ela vira o que a tela mostra: um resumo para a linha fechada, o
 * "O que fazer" destacado, os links como botões, os dados técnicos com rótulo
 * legível e, nos tipos que têm ficha própria, os dados já organizados.
 */

import { formatSpDateTime, formatSpDayMonth } from "@/src/domain/dates";
import { actorDisplayName } from "@/src/domain/production-write-actors";
import { MOTIVOS_DE_PERDA, rotuloDoMotivo } from "@/src/domain/recusa-de-captura";
import { fixtureHasPlaceholderTeam, splitEventoTeams } from "@/src/domain/text";
import { semEmoji } from "./texto-de-ui";

export type ActionLink = { label: string; href: string; external: boolean };
export type ActionFact = { label: string; value: string };

export type WriteAuthor = {
  name: string;
  /** "a seu pedido" (agente do dono) ou "sem autor" (ninguém assinou). */
  badge: string;
  unattributed: boolean;
  changes: number;
  actions: Array<{ text: string; code: string }>;
};

export type TicketLeg = { text: string; missing: string | null };

export type ActionCard =
  | { kind: "text"; paragraphs: string[] }
  | { kind: "writes"; authors: WriteAuthor[]; closing: string }
  | { kind: "refusals"; posts: number; tipster: string; reason: string; note: string | null }
  | { kind: "ticket"; post: string | null; postedAt: string | null; legs: TicketLeg[]; totals: string | null };

export type ActionReading = {
  summary: string;
  todo: string | null;
  links: ActionLink[];
  technical: ActionFact[];
  card: ActionCard;
};

type ActionInput = {
  title: string;
  description: string;
  actionType: string;
  evidence: unknown;
};

type Evidence = Record<string, unknown>;

const TODO_MARK = "👉";
const URL = /https?:\/\/\S+/g;
/** Campos que repetem o texto (`message`) ou são controle interno (`autoResolve`). */
const HIDDEN_EVIDENCE = new Set(["message", "autoResolve"]);

const FACT_LABELS: Record<string, string> = {
  dia: "Dia", reason: "Motivo", posts: "Posts", lastMessageId: "Último post", link: "Link",
  caption: "Legenda", postDate: "Postado em", editDate: "Editado em", mediaFileId: "Arquivo de mídia",
  extraction: "Leitura", escritas: "Escritas", bankroll: "Tipster", betId: "Aposta", count: "Quantidade",
};

/** Ações gravadas no registro de auditoria, ditas como o dono as reconhece. */
const AUDIT_ACTIONS: Record<string, string> = {
  "ops.apagar_apostas": "Apagou apostas pelo script de operação",
  "ops.apagar_aliases": "Apagou nomes de times pelo script de operação",
  "ops.zerar_ensaio": "Zerou o ensaio",
  "pgboss_queue.delete": "Apagou uma fila de tarefas do motor",
  "operational_action.auto_resolved": "Encerrou ações da caixa automaticamente",
  "bet.create": "Criou apostas",
  "bet.edit": "Editou apostas",
  "bet.soft_delete": "Removeu apostas",
  "bet.batch_remove": "Removeu apostas em lote",
  "bet.market_correct": "Corrigiu o mercado de apostas",
  "bet_result.copy_from_closing": "Copiou o resultado do fechamento para apostas",
  "bet_sharp.reopen_providerless_identity": "Reabriu a busca do jogo de apostas sem provedor",
  "bet_sharp.reopen_unmatched": "Reabriu a busca do jogo de apostas sem par",
  "market.create": "Criou mercados",
  "market_alias.create": "Criou apelidos de mercado",
  "market_alias.delete": "Apagou apelidos de mercado",
  "team_alias.backfill_canonical": "Preencheu os nomes oficiais dos times",
  "team_identity.delete": "Apagou identidades de time",
  "team_identity.promote": "Promoveu identidades de time",
  "team_provider_alias.reidentify": "Reidentificou nomes de times dos provedores",
  "team_provider_alias.revoke": "Revogou nomes de times",
  "team_provider_alias.unrevoke": "Desfez a revogação de nomes de times",
  "team_provider_alias.delete": "Apagou nomes de times",
  "team_provider_alias.learn": "Aprendeu nomes de times",
  "settlement.status_changed": "Mudou o resultado de apostas",
  "sharp.reprocess": "Reprocessou a busca do fechamento",
  "job.dlq_requeue": "Devolveu tarefas com falha para a fila",
  "job.dlq_discarded": "Descartou tarefas com falha",
  "conta.movement": "Lançou movimentações em contas",
  "bankroll.update": "Alterou tipsters",
  "bankroll.delete": "Apagou tipsters",
};

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const isRecord = (value: unknown): value is Evidence => typeof value === "object" && value !== null && !Array.isArray(value);
/** Registros antigos gravaram a quebra de linha como "\n" literal. */
const realNewlines = (text: string) => text.replace(/\\n/g, "\n");

function auditActionText(code: string): string {
  const known = AUDIT_ACTIONS[code];
  if (known) return known;
  const [, verb = code] = code.split(".");
  return capitalize(verb.replace(/[_.]/g, " "));
}

function linkLabel(prefix: string, href: string): string {
  if (/último post/i.test(prefix)) return "Abrir o último post";
  if (/^https?:\/\/t\.me\//.test(href)) return "Abrir o post no Telegram";
  return prefix ? prefix.replace(/:\s*$/, "") : "Abrir o link";
}

/**
 * As linhas do texto sem marcação, a linha 👉 separada como próximo passo e as
 * URLs tiradas do meio da frase para virar botão.
 */
export function readActionText(description: string): { lines: string[]; todo: string | null; links: ActionLink[] } {
  const lines: string[] = [];
  const links: ActionLink[] = [];
  let todo: string | null = null;
  for (const raw of realNewlines(description).split("\n")) {
    const isTodo = raw.trim().startsWith(TODO_MARK);
    const urls = raw.match(URL) ?? [];
    let line = semEmoji(raw.replace(URL, "")).trim();
    for (const href of urls) links.push({ label: linkLabel(line, href), href, external: true });
    // "Último post: <url>" sem a URL não diz mais nada.
    if (urls.length > 0 && /:$/.test(line)) line = "";
    if (!line) continue;
    if (isTodo && !todo) todo = line;
    else lines.push(line);
  }
  return { lines, todo, links };
}

function formatFactValue(key: string, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? "sim" : "não";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))) return formatSpDateTime(new Date(value));
    if (key === "reason") return `${rotuloDoMotivo(value)} (${value})`;
    return realNewlines(value).replace(/\s*\n\s*/g, " · ");
  }
  if (Array.isArray(value)) {
    if (value.every((item) => !isRecord(item) && !Array.isArray(item))) return value.map(String).join(", ");
    return `${value.length} ${value.length === 1 ? "item" : "itens"}`;
  }
  if (isRecord(value)) {
    const reader = isRecord(value.ocrEvidence) && Array.isArray(value.ocrEvidence.readers) ? value.ocrEvidence.readers[0] : null;
    if (isRecord(reader)) return [reader.model, reader.contractVersion].filter(Boolean).join(" · ");
    return `${Object.keys(value).length} campos`;
  }
  return String(value);
}

/** Os dados técnicos, com rótulo legível e sem os campos que a ficha já mostrou. */
export function technicalFacts(evidence: unknown, shown: readonly string[] = []): ActionFact[] {
  if (!isRecord(evidence)) return [];
  const facts: ActionFact[] = [];
  for (const [key, value] of Object.entries(evidence)) {
    if (HIDDEN_EVIDENCE.has(key) || shown.includes(key)) continue;
    const text = formatFactValue(key, value);
    if (text === null) continue;
    facts.push({ label: FACT_LABELS[key] ?? capitalize(key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase()), value: text });
  }
  return facts.slice(0, 8);
}

// ───────────── Fichas próprias ─────────────

function writeAuthor(entry: Evidence): WriteAuthor {
  const who = String(entry.quem ?? "");
  const agent = /^agent:([^:]+):por:(.+)$/.exec(who);
  const settlement = /^liquidação:(.+)$/.exec(who);
  const unattributed = entry.origem === "unattributed";
  const codes = Array.isArray(entry.acoes) ? entry.acoes.map(String) : [];
  return {
    name: agent ? actorDisplayName(who) : settlement ? `Liquidação por ${settlement[1]}` : who,
    badge: unattributed ? "sem autor" : "a seu pedido",
    unattributed,
    changes: Number(entry.eventos) || 0,
    actions: codes.map((code) => ({ text: auditActionText(code), code })),
  };
}

function readWrites(evidence: Evidence, todo: string | null): Omit<ActionReading, "links" | "technical"> {
  const authors = (evidence.escritas as unknown[]).filter(isRecord).map(writeAuthor);
  const day = typeof evidence.dia === "string" ? formatSpDayMonth(new Date(`${evidence.dia}T15:00:00Z`)) : null;
  const withoutAuthor = authors.filter((a) => a.unattributed).reduce((sum, a) => sum + a.changes, 0);
  const total = authors.reduce((sum, a) => sum + a.changes, 0);
  const until = day ? ` nas 24 h até ${day}` : " nas 24 h";
  const closing = withoutAuthor === 0
    ? `Nenhuma mudança sem autor${until}.`
    : `${withoutAuthor} ${withoutAuthor === 1 ? "mudança" : "mudanças"} sem autor${until}.`;
  const only = authors.length === 1 ? authors[0] : null;
  const summary = only
    ? `${only.name}${only.unattributed ? ", sem autor" : ", a seu pedido"}: ${only.changes} ${only.changes === 1 ? "mudança" : "mudanças"} em 24 h`
    : `${authors.length} autores, ${total} mudanças em 24 h${withoutAuthor > 0 ? `, ${withoutAuthor} sem autor` : ""}`;
  return { summary, todo, card: { kind: "writes", authors, closing } };
}

function readRefusals(input: ActionInput, evidence: Evidence, text: ReturnType<typeof readActionText>): Omit<ActionReading, "technical"> {
  const posts = Number(evidence.posts) || 0;
  const reason = rotuloDoMotivo(String(evidence.reason));
  const tipster = input.title.split(":")[0]?.trim() ?? "";
  // A 1ª linha (título) e a da contagem viram o número grande; sobra o aviso.
  const note = text.lines.find((line) => /^Enquanto isso/i.test(line)) ?? null;
  return {
    summary: `${posts} ${posts === 1 ? "post recusado" : "posts recusados"} em 24 h: ${reason}`,
    todo: text.todo,
    links: [...text.links, { label: "Esportes do tipster", href: "/config", external: false }],
    card: { kind: "refusals", posts, tipster, reason, note },
  };
}

const MARKET_WORDS: Record<string, string> = { "Money Line – Match": "vencedor", "Money Line": "vencedor" };

function readTicket(evidence: Evidence, description: string): Omit<ActionReading, "links" | "technical"> {
  const reason = typeof evidence.reason === "string" ? evidence.reason : "";
  const extraction = isRecord(evidence.extraction) ? evidence.extraction : {};
  const items = Array.isArray(extraction.items) && extraction.items.length > 0 ? extraction.items.filter(isRecord) : [extraction];
  const legs = items.map((item) => {
    const evento = typeof item.evento === "string" ? item.evento : "";
    const selecao = typeof item.selecao === "string" && item.selecao ? item.selecao : evento;
    const mercado = typeof item.mercado === "string" ? item.mercado : "";
    const noOpponent = reason === "incomplete_fixture" && (!splitEventoTeams(evento) || fixtureHasPlaceholderTeam(evento));
    return { text: [selecao, MARKET_WORDS[mercado] ?? mercado].filter(Boolean).join(" · "), missing: noOpponent ? "sem adversário" : null };
  }).filter((leg) => leg.text);
  const odds = typeof extraction.odds === "number" ? `odd ${extraction.odds.toFixed(2)}` : null;
  const stake = typeof extraction.stake === "number" ? `stake ${extraction.stake}u` : null;
  const date = typeof extraction.dataTexto === "string" ? `jogos em ${extraction.dataTexto.slice(0, 5)}` : null;
  const kind = legs.length > 1 ? "Múltipla" : null;
  const totals = [kind, odds, stake, date].filter(Boolean).join(" · ") || null;
  const missing = legs.filter((leg) => leg.missing).length;
  const summary = missing > 0
    ? legs.length === 1 ? "A leitura não trouxe o adversário do jogo" : `A leitura não trouxe os adversários de ${missing} dos ${legs.length} jogos`
    : readActionText(description).lines[0] ?? "";
  const todo = reason === "incomplete_fixture"
    ? "Confira no post quais são os jogos e registre à mão: sem o adversário, a aposta não casa com a Pinnacle."
    : MOTIVOS_DE_PERDA[reason] ? capitalize(MOTIVOS_DE_PERDA[reason].proximaEtapa) + "." : null;
  const caption = typeof evidence.caption === "string" ? realNewlines(evidence.caption).replace(/\n{2,}/g, "\n").trim() : null;
  const postedAt = typeof evidence.postDate === "string" && Number.isFinite(Date.parse(evidence.postDate))
    ? formatSpDateTime(new Date(evidence.postDate)) : null;
  return { summary, todo, card: { kind: "ticket", post: caption, postedAt, legs, totals } };
}

/** A ação lida para a tela: ficha própria quando o tipo tem uma, texto limpo nos outros. */
export function readAction(input: ActionInput): ActionReading {
  const text = readActionText(input.description);
  const evidence = isRecord(input.evidence) ? input.evidence : {};
  if (Array.isArray(evidence.escritas)) {
    return { ...readWrites(evidence, text.todo), links: text.links, technical: technicalFacts(evidence, ["escritas", "dia"]) };
  }
  if (typeof evidence.posts === "number" && typeof evidence.reason === "string" && /recusas repetidas/i.test(input.title)) {
    return { ...readRefusals(input, evidence, text), technical: technicalFacts(evidence, ["posts"]) };
  }
  if (input.actionType === "capture_review" && isRecord(evidence.extraction)) {
    const link = typeof evidence.link === "string" ? [{ label: "Abrir o post no Telegram", href: evidence.link, external: true }] : [];
    return { ...readTicket(evidence, input.description), links: link, technical: technicalFacts(evidence, ["caption", "link", "postDate"]) };
  }
  const [first = "", ...rest] = text.lines;
  // A 1ª linha é o resumo da linha fechada; o corpo começa depois dela.
  return { summary: first, todo: text.todo, links: text.links, technical: technicalFacts(evidence), card: { kind: "text", paragraphs: rest.length > 0 ? rest : [] } };
}
