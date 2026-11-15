import { OperationalRisk } from "@/src/generated/prisma/client";
import { spDayKey } from "@/src/domain/dates";
import { classifyAuditActor, classifySettlementSource, DELEGATED_ACTOR, type WriteOrigin } from "@/src/domain/production-write-actors";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { sendOperationalAlert } from "@/src/services/ops/alerts";
import { DELEGATED_DECISION_SQL, FUNCIONARIO_WRITE_LIMITS } from "@/src/services/ops/funcionario/escrita";

const log = createLogger("escritas-fora-do-fluxo");
const HOUR_MS = 60 * 60 * 1000;
const JANELA_MS = 24 * HOUR_MS;
/** Até onde a revisão volta quando ficou dias sem rodar. */
const JANELA_MAX_MS = 7 * JANELA_MS;
const MAX_LINHAS = 20;
/** A marca de cada revisão concluída: a seguinte começa de onde esta parou. */
const REVIEW_DONE_ACTION = "consistency.escritas_revistas";

export type EscritaAgrupada = { quem: string; origem: WriteOrigin; eventos: number; acoes: string[] };

/** O começo da janela: o fim da última revisão concluída (até 7 dias atrás); sem nenhuma, 24 h. */
async function reviewWindowStart(now: Date): Promise<Date> {
  const last = await prisma.auditEvent.findFirst({
    where: { actor: "system", action: REVIEW_DONE_ACTION },
    orderBy: { createdAt: "desc" },
    select: { details: true },
  });
  const until = Date.parse(String((last?.details as { ate?: unknown } | null)?.ate ?? ""));
  if (Number.isNaN(until)) return new Date(now.getTime() - JANELA_MS);
  return new Date(Math.min(now.getTime(), Math.max(until, now.getTime() - JANELA_MAX_MS)));
}

/**
 * Resumo diário, em `/operacoes`, das escritas desde a última revisão que não
 * vieram do fluxo automático nem do operador pelo painel: intervenções de
 * agentes e scripts, assumidas (`agent:…:por:…`) ou não. Um item por dia — é
 * revisão, não alarme por evento. Não detecta script que grave com o nome do
 * operador; para isso a liquidação delegada registra o agente (`ops-settle`).
 *
 * As decisões com evidência dos agentes do dono (vincular, adiar, esporte e
 * liquidar: o funcionário de IA) são rotina enquanto cabem no teto dele, e
 * não abrem item; acima do teto, ou qualquer outra escrita de agente, abre.
 *
 * Tentativas de login (`auth.login_*` em `auth`) ficam de fora: não escrevem
 * nada do negócio, e o "ator" delas é o que alguém digitou no formulário, sem
 * autenticação. Outra ação que venha a gravar em `auth` continua aparecendo.
 */
export async function checkEscritasForaDoFluxo(now = new Date()): Promise<{ escritas: EscritaAgrupada[] }> {
  const desde = await reviewWindowStart(now);
  const [usuarios, atores, fontes] = await Promise.all([
    prisma.authSessionState.findMany({ select: { username: true } }),
    prisma.$queryRaw<Array<{ actor: string; action: string; decision: boolean; eventos: number }>>`
      SELECT actor, action, ${DELEGATED_DECISION_SQL} AS decision, count(*)::int AS eventos
      FROM audit_events
      WHERE "createdAt" >= ${desde} AND "createdAt" < ${now}
        AND (resource IS NULL OR resource <> 'auth' OR left(action, 11) <> 'auth.login_')
      GROUP BY 1, 2, 3`,
    // Só na mudança de status o `source` é o autor da liquidação; nos eventos de
    // prop de jogador ele é a proveniência da leitura ou a evidência digitada.
    prisma.$queryRaw<Array<{ source: string; eventos: bigint }>>`
      SELECT "payload"->>'source' AS source, count(*) AS eventos
      FROM "settlement_events"
      WHERE "type" = 'STATUS_CHANGED' AND "createdAt" >= ${desde} AND "createdAt" < ${now}
      GROUP BY 1`,
  ]);
  const painel = new Set(usuarios.map((u) => u.username));

  const grupos = new Map<string, EscritaAgrupada>();
  const somar = (quem: string, origem: WriteOrigin, eventos: number, acao: string) => {
    const atual = grupos.get(quem) ?? { quem, origem, eventos: 0, acoes: [] };
    atual.eventos += eventos;
    if (!atual.acoes.includes(acao)) atual.acoes.push(acao);
    grupos.set(quem, atual);
  };
  // As decisões com evidência de cada dono; acima do teto do período deixam de ser rotina.
  const decisions = new Map<string, number>();
  for (const linha of atores) {
    const owner = DELEGATED_ACTOR.exec(linha.actor)?.[1];
    if (owner && linha.decision) decisions.set(owner, (decisions.get(owner) ?? 0) + linha.eventos);
  }
  const ceiling = FUNCIONARIO_WRITE_LIMITS.perDay * Math.max(1, Math.ceil((now.getTime() - desde.getTime()) / JANELA_MS));
  let rotina = 0;
  for (const linha of atores) {
    const origem = classifyAuditActor(linha.actor, painel);
    if (origem === "automatic" || origem === "operator") continue;
    const owner = DELEGATED_ACTOR.exec(linha.actor)?.[1];
    if (origem === "delegated" && linha.decision && owner && (decisions.get(owner) ?? 0) <= ceiling) {
      rotina += linha.eventos;
      continue;
    }
    somar(linha.actor, origem, linha.eventos, linha.action);
  }
  for (const linha of fontes) {
    const source = linha.source ?? "(sem fonte)";
    if (classifySettlementSource(source, painel) !== "unattributed") continue;
    somar(`liquidação:${source}`, "unattributed", Number(linha.eventos), "settlement.status_changed");
  }

  const escritas = [...grupos.values()].sort((a, b) =>
    Number(a.origem === "delegated") - Number(b.origem === "delegated") || b.eventos - a.eventos || a.quem.localeCompare(b.quem));
  const done = () => prisma.auditEvent.create({ data: {
    actor: "system", action: REVIEW_DONE_ACTION, resource: "audit",
    details: { desde: desde.toISOString(), ate: now.toISOString(), origens: escritas.length, rotina },
  } });
  if (escritas.length === 0) {
    await done();
    return { escritas };
  }

  const semAutoria = escritas.filter((e) => e.origem === "unattributed");
  const linhas = escritas.slice(0, MAX_LINHAS).map((e) =>
    `${e.origem === "delegated" ? "🤝" : "⚠️"} ${e.quem}: ${e.eventos} (${e.acoes.slice(0, 4).join(", ")})`);
  const dia = spDayKey(now);
  const horas = Math.max(1, Math.round((now.getTime() - desde.getTime()) / HOUR_MS));
  await sendOperationalAlert(
    `🧾 Mudanças feitas fora do fluxo normal (${horas}h até ${dia})\n` +
      `${semAutoria.length} sem autor identificado, ${escritas.length - semAutoria.length} feitas por agente a seu pedido.\n` +
      linhas.join("\n") +
      (escritas.length > MAX_LINHAS ? `\n… e mais ${escritas.length - MAX_LINHAS}.` : "") +
      (rotina > 0 ? `\n🤖 Fora desta lista: ${rotina} decisões do funcionário de IA, com evidência e dentro do teto.` : "") +
      "\n👉 Confira se cada uma foi pedida por você e está correta.",
    {
      source: "consistency.escritas-fora-do-fluxo",
      key: dia,
      title: "Escritas fora do fluxo automático",
      risk: semAutoria.length > 0 ? OperationalRisk.HIGH : OperationalRisk.LOW,
      resource: "audit",
      autoResolve: false,
      evidence: { dia, desde: desde.toISOString(), escritas: escritas.slice(0, MAX_LINHAS).map((e) => ({ ...e })) },
    },
  );
  await done();
  log.warn({ dia, origens: escritas.length, semAutoria: semAutoria.length }, "escritas fora do fluxo automático");
  return { escritas };
}
