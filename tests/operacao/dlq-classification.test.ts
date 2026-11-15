import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyDlqError,
  extractDlqErrorPayload,
  isBusinessLogicError,
  isDatabaseFailure,
  isTransientDlqError,
} from "@/src/domain/dlq-classification";
import { CircuitOpenError } from "@/src/infra/circuit-breaker";
import { ProviderRequestError } from "@/src/domain/provider-error";
import { transientDlqRequeueMax } from "@/src/services/ops/dlq/handler";
import { BetNotPendingError, SportNotConfirmedError } from "@/src/services/bets/settle";

/**
 * Portão: o classificador da DLQ precisa reconhecer o vocabulário do PRÓPRIO
 * pg-boss para "o worker foi embora".
 *
 * Quando um job é abandonado, quem escreve o motivo não é o Automabaca — é o
 * pg-boss, com strings dele. São três (`manager.js`): `'pg-boss shut down while
 * active'`, quando reprova o job ativo durante o drain do reload; `'handler
 * execution exceeded Ns'`, quando o timer do próprio worker vivo reprova o
 * handler que passou de `expire_seconds` (o caso comum); e `'job timed out'`,
 * quando o supervisor expira o job que ninguém reprovou (processo morto ou
 * event loop travado).
 *
 * As três são o caso MAIS transitório que existe — o trabalho está intacto e
 * só a execução saiu. Se caírem como `other`, ficam retidas para replay MANUAL,
 * e basta uma grafia parecida (`"timeout"` contra o `"timed out"` do pg-boss)
 * para isso acontecer.
 *
 * Um teste de exemplo não protege aqui: ele afirma a string que alguém lembrou
 * de escrever, e uma grafia parecida o suficiente parece coberta. Este portão
 * vai LER os literais do pg-boss instalado, e reprova sozinho se um upgrade
 * mudar a redação — a versão nova passaria a cair em `other`, em silêncio.
 *
 * Mesma família de `tests/vocabulario-formas-de-linha.test.ts`: grafia não
 * reconhecida mudando o desfecho.
 */

/**
 * Resolvido pelo Node, não por caminho fixo: em worktree do Git o
 * `node_modules` vive no repo PAI, e um caminho relativo daqui aponta para uma
 * pasta que não existe — o portão morreria de erro de arquivo em vez de
 * conferir o que veio a conferir.
 */
const MANAGER = path.join(
  path.dirname(createRequire(import.meta.url).resolve("pg-boss")),
  "manager.js",
);

/**
 * Extrai um literal do pg-boss instalado. LANÇA quando não acha: se o upgrade
 * renomeou a razão, o portão precisa falhar pedindo revisão, não passar por
 * não ter encontrado nada para conferir.
 */
function literalDoPgBoss(fonte: string, padrao: RegExp, apelido: string): string {
  const achado = padrao.exec(fonte);
  if (!achado?.[1]) {
    throw new Error(
      `Razão de abandono "${apelido}" não encontrada em pg-boss/dist/manager.js. ` +
        "O upgrade mudou a redação: confira a nova string e cubra-a em " +
        "isTransientDlqError antes de seguir — sem isso ela volta a ser " +
        "classificada como `other` e retida para replay manual.",
    );
  }
  return achado[1];
}

describe("vocabulário de abandono do pg-boss", () => {
  const fonte = readFileSync(MANAGER, "utf8");

  /** `this.fail(worker.name, <jobs>, 'pg-boss shut down while active')` */
  const reloadDerrubou = literalDoPgBoss(
    fonte,
    /this\.fail\([^;]*?'(pg-boss shut down[^']*)'/,
    "reload derrubou job ativo",
  );
  /** `expireJobsDistributed(..., { value: { message: 'job timed out' } })` */
  const expirou = literalDoPgBoss(
    fonte,
    /message:\s*'([^']*timed out[^']*)'/,
    "job expirou sem quem o concluísse",
  );
  /** `resolveWithinSeconds(..., `handler execution exceeded ${maxExpiration}s`, ac)` */
  const handlerEstourou = literalDoPgBoss(
    fonte,
    /`(handler execution exceeded) \$\{/,
    "handler passou do prazo da fila",
  );

  /**
   * As formas em que o pg-boss PERSISTE cada razão em `pgboss.job.output`.
   * A forma importa: nas duas primeiras o texto vive aninhado sob `value`,
   * então `extractDlqErrorPayload` cai no ramo do `JSON.stringify` e o
   * classificador só enxerga a string inteira; a do timer é o `Error`
   * serializado (`serialize-error`).
   */
  const casos: Array<{ apelido: string; output: unknown }> = [
    { apelido: "reload derrubou job ativo", output: { value: reloadDerrubou } },
    { apelido: "job expirou", output: { value: { message: expirou } } },
    { apelido: "handler passou do prazo", output: {
      name: "Error", message: `${handlerEstourou} 900s`, stack: `Error: ${handlerEstourou} 900s\n    at Timeout._onTimeout`,
    } },
  ];

  it.each(casos)("classifica '$apelido' como transitório", ({ output }) => {
    const payload = extractDlqErrorPayload(output);
    expect(
      classifyDlqError({
        name: payload.name,
        status: payload.status,
        message: payload.message,
      }),
      `pg-boss abandonou o job e o Automabaca precisa REQUEUE, não replay ` +
        `manual — output persistido: ${JSON.stringify(output)}`,
    ).toBe("transient");
  });

  it("não confia na grafia parecida que já existia", () => {
    // Um marcador `"timeout"` não casa com `"timed out"`. Se ele for o único, a
    // asserção acima cai — esta aqui explica por quê, sem depender do código.
    expect(expirou.toLowerCase()).not.toContain("timeout");
    expect(expirou.toLowerCase()).toContain("timed out");
  });
});

describe("isTransientDlqError", () => {
  it("reconhece 429 / rate limit / breaker", () => {
    expect(isTransientDlqError("BridgeOdds query falhou: HTTP 429")).toBe(true);
    expect(isTransientDlqError("Too Many Requests")).toBe(true);
    expect(isTransientDlqError("rate limit exceeded")).toBe(true);
    expect(
      isTransientDlqError('CircuitOpenError: Circuit breaker aberto para "bridgeodds"'),
    ).toBe(true);
  });

  it("reconhece rede / 5xx", () => {
    expect(isTransientDlqError("fetch failed")).toBe(true);
    expect(isTransientDlqError("timeout")).toBe(true);
    expect(isTransientDlqError("502 Bad Gateway")).toBe(true);
  });

  it("rejeita erros de negócio", () => {
    expect(isBusinessLogicError("Zod validation failed")).toBe(true);
    expect(isTransientDlqError("Zod validation failed")).toBe(false);
    expect(isTransientDlqError("erro de logica gravíssimo")).toBe(false);
    expect(isTransientDlqError("")).toBe(false);
  });
});

describe("classifyDlqError (tipado)", () => {
  it("CircuitOpenError / ProviderRequestError 429 → transient", () => {
    expect(classifyDlqError(new CircuitOpenError("bridgeodds"))).toBe("transient");
    expect(
      classifyDlqError(
        new ProviderRequestError("BridgeOdds", { status: 429, error: "HTTP 429" }),
      ),
    ).toBe("transient");
    expect(
      classifyDlqError({ name: "ProviderRequestError", status: 503, message: "unavailable" }),
    ).toBe("transient");
  });

  it("BetNotPendingError → business", () => {
    expect(classifyDlqError(new BetNotPendingError("bet-1", "WON"))).toBe("business");
  });

  it("recusa de negócio é business, inclusive subclasse serializada pelo pg-boss", async () => {
    const { RecusaDeNegocioError } = await import("@/src/services/shared/recusa");
    const { InvalidSettlementMarketError } = await import("@/src/services/bets/settle");
    const { classificaCausa } = await import("@/src/domain/falha-de-job");
    // O pg-boss grava as propriedades próprias do erro (serialize-error).
    const serializeError = (error: Error) => ({ ...JSON.parse(JSON.stringify(error)), name: error.name, message: error.message });
    const recusa = new RecusaDeNegocioError("A aposta possui kickoff provisório.");
    expect(classifyDlqError(recusa)).toBe("business");
    expect(classifyDlqError(extractDlqErrorPayload(serializeError(recusa)))).toBe("business");
    const subclasse = serializeError(new InvalidSettlementMarketError("bet-1", "Moneyline", "PUSH"));
    expect(classifyDlqError(extractDlqErrorPayload(subclasse))).toBe("business");
    expect(classificaCausa(subclasse)).toBe("regra_de_negocio");
    // Recusa de kickoff espera o tempo: continua negócio (sem requeue), mas diz o que esperar.
    const { assertSettlementKickoff } = await import("@/src/services/bets/settle");
    let futuro: unknown;
    try { assertSettlementKickoff({ data: new Date(Date.now() + 3_600_000), kickoffInferido: false }, "WON", new Date()); } catch (err) { futuro = err; }
    const payload = extractDlqErrorPayload(serializeError(futuro as Error));
    expect(payload).toMatchObject({ businessRefusal: true, waitsFor: "o evento começar" });
    expect(classifyDlqError(payload)).toBe("business");
    expect(classificaCausa(serializeError(futuro as Error))).toBe("regra_aguardando");
    // A recusa que se resolve sozinha continua transitória.
    expect(classifyDlqError(extractDlqErrorPayload(serializeError(new SportNotConfirmedError("bet-1"))))).toBe("transient");
  });

  it("SportNotConfirmedError → transient", () => {
    expect(classifyDlqError(new SportNotConfirmedError("bet-1"))).toBe("transient");
    expect(
      classifyDlqError("Aposta bet-1 ainda não possui esporte confirmado"),
    ).toBe("transient");
    expect(transientDlqRequeueMax("SportNotConfirmedError", "")).toBe(12);
    expect(transientDlqRequeueMax(undefined, "fetch failed")).toBe(3);
  });

  it("PrePinnacleRetryError continua no fluxo transitório da DLQ", () => {
    expect(classifyDlqError({
      name: "PrePinnacleRetryError",
      message: "Match não encontrado — aguardando Pinnacle listar.",
    })).toBe("transient");
    expect(transientDlqRequeueMax("PrePinnacleRetryError", "")).toBe(3);
  });

  it("BetRemovedError é negócio — aposta apagada não reentra na fila", () => {
    expect(classifyDlqError({
      name: "BetRemovedError",
      message: "Aposta abc está removida — edição ignorada.",
    })).toBe("business");
    expect(classifyDlqError("Aposta abc está removida — edição ignorada.")).toBe("business");
  });

  it("TelegramParseRetryError continua no fluxo transitório da DLQ", () => {
    expect(classifyDlqError({
      name: "TelegramParseRetryError",
      message: "Cascata LLM indisponível para texto do Telegram.",
    })).toBe("transient");
    expect(transientDlqRequeueMax("TelegramParseRetryError", "")).toBe(3);
  });

  it("mensagem legada ainda funciona", () => {
    expect(isTransientDlqError("BridgeOdds query falhou: HTTP 429")).toBe(true);
    expect(classifyDlqError("fetch failed")).toBe("transient");
    expect(classifyDlqError("Zod validation failed")).toBe("business");
  });
});

/**
 * Mensagens reais do Prisma, como o pg-boss as grava em `pgboss.job.output`
 * (serialize-error: `name`, `code` e `message`). Toda mensagem começa com
 * "Invalid `prisma.x()` invocation", e o marcador genérico `"invalid "` da
 * recusa de negócio não pode tomá-las por "a regra recusou".
 */
describe("classifyDlqError com erro do Prisma", () => {
  const known = (code: string, message: string) => ({ name: "PrismaClientKnownRequestError", code, message });
  const unknown = (message: string) => ({ name: "PrismaClientUnknownRequestError", message });

  it.each([
    ["pool esgotado (P2024)", known("P2024", "\nInvalid `prisma.bet.findMany()` invocation:\n\nTimed out fetching a new connection from the connection pool.")],
    ["transação expirada (P2028)", known("P2028", "\nInvalid `prisma.bet.count()` invocation:\n\nTransaction API error: A commit cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms")],
    ["statement_timeout (57014)", unknown("\nInvalid `prisma.operationalMetric.create()` invocation:\n\nDatabase error. Code: `57014`")],
    ["banco reiniciando (57P01)", unknown("\nInvalid `prisma.bet.findMany()` invocation:\n\nterminating connection due to administrator command")],
    ["conflito de escrita (P2034)", known("P2034", "\nInvalid `prisma.bet.update()` invocation:\n\nTransaction failed due to a write conflict or a deadlock. Please retry your transaction")],
  ])("%s é passageiro", (_caso, output) => {
    expect(classifyDlqError(extractDlqErrorPayload(output))).toBe("transient");
  });

  it("schema divergente no meio de um deploy não é recusa de negócio", () => {
    // Worker antigo contra o schema novo: coluna removida, valor de enum que saiu.
    expect(classifyDlqError(extractDlqErrorPayload(known("P2007",
      "\nInvalid `prisma.bet.findMany()` invocation:\n\nInvalid input value: invalid input value for enum \"SharpMode\": \"FULL\"")))).toBe("other");
    expect(classifyDlqError(extractDlqErrorPayload(known("P2022",
      "\nInvalid `prisma.bet.count()` invocation:\n\nThe column `j3.entryFairOdd` does not exist in the current database.")))).toBe("other");
  });

  it("unicidade e registro sumido continuam recusa do dado", () => {
    expect(classifyDlqError(known("P2002", "\nInvalid `prisma.bet.create()` invocation:\n\nUnique constraint failed on the fields: (`id`)"))).toBe("business");
    expect(classifyDlqError(known("P2025", "\nInvalid `prisma.bet.update()` invocation:\n\nAn operation failed because it depends on one or more records that were required but not found."))).toBe("business");
  });

  it("mensagem legada sem nome nem código também é lida como Prisma", () => {
    expect(classifyDlqError("\nInvalid `prisma.bet.count()` invocation:\n\nTransaction API error: Unable to start a transaction in the given time.")).toBe("transient");
    expect(classifyDlqError({ name: "Error", message: "Transaction API error: Unable to start a transaction in the given time." })).toBe("transient");
    expect(isBusinessLogicError("\nInvalid `prisma.bet.count()` invocation:\n\nTimed out fetching a new connection")).toBe(false);
  });
});

describe("falha do banco fora do cabeçalho prisma.x()", () => {
  it("SQLSTATE vale só no formato Code: `…`, não como número solto na mensagem", () => {
    expect(classifyDlqError({ name: "PrismaClientUnknownRequestError",
      message: "\nInvalid `prisma.bet.update()` invocation:\n\nValue out of range for the type: 53000" })).toBe("other");
    expect(classifyDlqError({ name: "PrismaClientUnknownRequestError",
      message: "\nInvalid `prisma.$queryRaw()` invocation:\n\nRaw query failed. Code: `57014`. Message: `canceling statement due to statement timeout`" }))
      .toBe("transient");
  });

  it("SQLSTATE passageiro no code do erro do driver é passageiro", () => {
    expect(classifyDlqError({ name: "error", code: "40P01", message: "deadlock detected" })).toBe("transient");
    expect(classifyDlqError({ name: "error", code: "23505", message: "duplicate key value violates unique constraint" })).toBe("business");
  });

  it("Prisma dentro de transação (`tx.x()`) é lido como Prisma, não como recusa", () => {
    expect(classifyDlqError("\nInvalid `tx.bet.update()` invocation:\n\nTransaction API error: Transaction already closed: "
      + "A commit cannot be executed on an expired transaction.")).toBe("transient");
    expect(classifyDlqError({ name: "Error", code: "P2028",
      message: "\nInvalid `tx.operationalAction.updateMany()` invocation:\n\nTransaction not found." })).toBe("transient");
  });

  it("conexão quebrada do driver pg é passageira", () => {
    expect(classifyDlqError({ name: "Error", message: "Client has encountered a connection error and is not queryable" }))
      .toBe("transient");
    expect(classifyDlqError({ name: "Error", message: "Connection terminated unexpectedly" })).toBe("transient");
    expect(classifyDlqError({ name: "Error", message: "timeout exceeded when trying to connect" })).toBe("transient");
  });

  it("isDatabaseFailure separa o banco que não atende da espera de provider", () => {
    expect(isDatabaseFailure({ name: "PrismaClientKnownRequestError", code: "P2028", message: "x" })).toBe(true);
    expect(isDatabaseFailure({ name: "error", code: "57014", message: "canceling statement due to statement timeout" })).toBe(true);
    expect(isDatabaseFailure(new Error("Client has encountered a connection error and is not queryable"))).toBe(true);
    expect(isDatabaseFailure(new CircuitOpenError("bridgeodds"))).toBe(false);
    expect(isDatabaseFailure({ name: "PrePinnacleRetryError", message: "Match não encontrado — aguardando Pinnacle listar." })).toBe(false);
  });
});
