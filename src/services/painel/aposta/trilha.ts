import "server-only";
import { actorDisplayName, settlementSourceActor } from "@/src/domain/production-write-actors";
import {
  type ChaveDeEvento,
  type EventoBruto,
  type MudancaDeCampo,
  type Trecho,
  EVENTOS_DA_TRILHA,
  classificarEventoDeAuditoria,
  narrar,
} from "@/src/domain/trilha-da-aposta";
import { prisma } from "@/src/infra/prisma";
import {
  AUDIT_FINANCIAL_RETENTION_DAYS,
} from "@/src/services/ops/audit-purge";

/**
 * A história da aposta — `audit_events` e `settlement_events` numa lista só.
 *
 * São DUAS tabelas porque são dois assuntos: a auditoria registra o que o
 * sistema decidiu sobre a aposta (captura, edição, identidade, kickoff) e o
 * ledger de settlement registra o que ela virou (`STATUS_CHANGED`). Nenhuma das
 * duas sozinha conta a história.
 *
 * Duas consultas por índice já existente (`[resource, resourceId, action]` e
 * `[betId, createdAt]`), escopo de uma aposta, em paralelo.
 */

export type LinhaDaTrilha = {
  id: string;
  chave: ChaveDeEvento;
  rotulo: string;
  /** ISO — a tela formata; o instante atravessa, nunca a string. */
  em: string;
  ator: string;
  /** `false` marca o que não deu certo, sem inventar prosa de erro. */
  ok: boolean;
  frase: Trecho[];
  mudancas: MudancaDeCampo[];
};

export type TrilhaDaAposta = {
  linhas: LinhaDaTrilha[];
  /**
   * A trilha tem a GÊNESE (`bet.create`)? `bet.create` é escrito para toda
   * aposta, então a ausência dele significa que o registro se foi — pela purga
   * ou por a aposta ser anterior à auditoria. Nos dois casos a lista mostra um
   * pedaço, e uma história curta pareceria uma aposta sem história.
   *
   * Perguntar isso à LISTA, e não comparar datas com o corte, é o que faz o
   * sinal funcionar — evento anterior ao corte já não existe para ser medido.
   */
  completa: boolean;
  /** O evento mais antigo que sobrou, quando a trilha está truncada. */
  comecaEm: string | null;
  /** Por quantos dias o registro é guardado — para a tela poder dizer. */
  retencaoDias: number;
  /** Resultado trocado depois de liquidada — a marca que a lista exibe. */
  reliquidada: boolean;
};

type LinhaDeAuditoria = {
  id: string;
  action: string;
  actor: string;
  outcome: string;
  createdAt: Date;
  details: unknown;
};

type LinhaDeSettlement = {
  id: string;
  payload: unknown;
  createdAt: Date;
  /** Resultado trocado depois de liquidada, pela função do banco (ver `reliquidacao.ts`). */
  resettles: boolean;
};

/** `details`/`payload` são `Json?`: qualquer coisa que não seja objeto vira `{}`. */
function comoObjeto(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function paraLinha(id: string, evento: EventoBruto): LinhaDaTrilha {
  const { frase, mudancas } = narrar(evento);
  return {
    id,
    chave: evento.chave,
    rotulo: EVENTOS_DA_TRILHA[evento.chave].rotulo,
    em: evento.em.toISOString(),
    ator: evento.ator,
    ok: evento.outcome === "success",
    frase,
    mudancas: mudancas ?? [],
  };
}

export async function getTrilhaDaAposta(betId: string): Promise<TrilhaDaAposta> {
  const [auditoria, settlement] = await Promise.all([
    prisma.$queryRaw<LinhaDeAuditoria[]>`
      SELECT id, action, actor, outcome, "createdAt", details
      FROM audit_events
      WHERE resource = 'bet' AND "resourceId" = ${betId}
      ORDER BY "createdAt" DESC
    `,
    prisma.$queryRaw<LinhaDeSettlement[]>`
      SELECT id, payload, "createdAt", settlement_event_is_resettlement(type, payload) AS resettles
      FROM settlement_events
      WHERE "betId" = ${betId} AND type = 'STATUS_CHANGED'
      ORDER BY "createdAt" DESC
    `,
  ]);

  const linhas: LinhaDaTrilha[] = [];

  for (const row of auditoria) {
    const dados = comoObjeto(row.details);
    const chave = classificarEventoDeAuditoria(row.action, dados);
    // Fora do vocabulário é DESCARTE, não linha muda: exibir sem saber narrar
    // mostraria linha sem sentido na ficha.
    if (!chave) continue;
    linhas.push(paraLinha(row.id, {
      chave, em: row.createdAt, ator: actorDisplayName(row.actor), outcome: row.outcome, dados,
    }));
  }

  let reliquidada = false;
  for (const row of settlement) {
    if (row.resettles) reliquidada = true;
    const dados = comoObjeto(row.payload);
    const source = typeof dados.source === "string" ? dados.source : "";
    linhas.push(paraLinha(row.id, {
      chave: dados.to === "PENDING" ? "reabertura" : row.resettles ? "reliquidacao" : "liquidacao",
      em: row.createdAt, ator: actorDisplayName(settlementSourceActor(source) ?? "system"), outcome: "success", dados,
    }));
  }

  // Mais novo primeiro. Empate desempata por id para a ordem ser estável entre
  // renders — `createdAt` de duas escritas na mesma transação pode coincidir.
  linhas.sort((a, b) => (b.em.localeCompare(a.em) || a.id.localeCompare(b.id)));

  const completa = linhas.some((l) => l.chave === "captura");
  return {
    linhas,
    completa,
    comecaEm: completa ? null : (linhas.at(-1)?.em ?? null),
    retencaoDias: AUDIT_FINANCIAL_RETENTION_DAYS,
    reliquidada,
  };
}
