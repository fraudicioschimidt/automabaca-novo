import { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/infra/prisma";
import { createLogger } from "@/src/infra/logger";

const log = createLogger("tx");

export const SERIALIZABLE_TX_TIMEOUT_MS = 15_000;
const MAX_TRANSACTION_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 150;

const SERIALIZABLE_TRANSACTION_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 5_000,
  timeout: SERIALIZABLE_TX_TIMEOUT_MS,
} as const;

export type TransactionWriteGuard = (tx: Prisma.TransactionClient) => Promise<void>;

/** Client parcial — permite injetar o client de teste (só o overload callback). */
export type SerializableTransactionClient = {
  readonly inExistingTransaction?: true;
  $transaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: {
      timeout?: number;
      maxWait?: number;
      isolationLevel?: Prisma.TransactionIsolationLevel;
    },
  ): Promise<T>;
};

/** Prisma transaction clients are proxies and cannot be spread. Reuse their
 * delegates without opening/retrying an inner transaction after SSI aborts. */
export function reuseSerializableTransaction(tx: Prisma.TransactionClient): Prisma.TransactionClient & SerializableTransactionClient {
  const wrapper = {
    inExistingTransaction: true as const,
    $transaction: async <T>(operation: (inner: Prisma.TransactionClient) => Promise<T>) => operation(tx),
  };
  return new Proxy(wrapper, {
    get(target, key) { return key in target ? Reflect.get(target, key) : Reflect.get(tx, key); },
  }) as unknown as Prisma.TransactionClient & SerializableTransactionClient;
}

/**
 * SQLSTATEs da classe 40 que o Postgres manda RETENTAR. `40001` é o conflito de
 * serialização do SSI; `40P01` é deadlock. Ambos significam "sua transação foi
 * abortada, tente de novo" — nunca "seu dado está errado".
 */
const SQLSTATES_RETENTAVEIS = new Set(["40001", "40P01"]);

/**
 * Procura a marca do conflito em QUALQUER profundidade do erro.
 *
 * Estrutura, nunca mensagem: o texto do Postgres é localizável e mudaria com
 * `lc_messages`. E percorrendo a cadeia porque a FORMA do erro depende da
 * camada do Prisma — ver `isSerializationConflict`.
 */
function temMarcaDeConflito(valor: unknown, profundidade = 0): boolean {
  if (profundidade > 6 || !valor || typeof valor !== "object") return false;
  const objeto = valor as Record<string, unknown>;
  const codigo = objeto["originalCode"];
  if (typeof codigo === "string" && SQLSTATES_RETENTAVEIS.has(codigo)) return true;
  if (objeto["kind"] === "TransactionWriteConflict") return true;
  return (
    temMarcaDeConflito(objeto["cause"], profundidade + 1) ||
    temMarcaDeConflito(objeto["meta"], profundidade + 1) ||
    temMarcaDeConflito(objeto["driverAdapterError"], profundidade + 1)
  );
}

/**
 * Conflito de serialização — o que este retry existe para absorver.
 *
 * Com Prisma + adapter-pg o conflito NÃO chega como `P2034`, e sim em duas formas:
 * - dentro de `$executeRaw` (caminho do `settlement_events`):
 *   `PrismaClientKnownRequestError` com `code: "P2010"` e o SQLSTATE em
 *   `meta.driverAdapterError.cause.originalCode`;
 * - pelo cliente Prisma normal: `DriverAdapterError` cru, com
 *   `cause.kind: "TransactionWriteConflict"`.
 * Checar só `P2034` mata em silêncio o retry do ledger e da detecção de
 * duplicata. `P2034` fica por compatibilidade; a detecção de verdade é pelo
 * SQLSTATE, e `tests/dinheiro/transaction-retry.db.test.ts` (concorrência real) impede
 * a forma de mudar sem ninguém notar.
 */
function isSerializationConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
    return true;
  }
  return temMarcaDeConflito(error);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Transação Serializable com retry+jitter em conflito de serialização — o
 * padrão do projeto para todo fluxo onde concorrência corrompe dados: ledger financeiro
 * (`Conta.saldoAtual`/`Movimentacao`) e detecção de duplicata por leitura
 * (o SSI do Postgres detecta phantom-insert e aborta um dos lados; o retry
 * reencontra a linha do vencedor).
 */
export async function runSerializableTransaction<T>(
  label: string,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { timeoutMs?: number; client?: SerializableTransactionClient; beforeWrite?: TransactionWriteGuard },
): Promise<T> {
  const db = options?.client ?? prisma;
  const guarded = async (tx: Prisma.TransactionClient) => {
    await options?.beforeWrite?.(tx);
    return operation(tx);
  };
  if ("inExistingTransaction" in db && db.inExistingTransaction) return db.$transaction(guarded);
  const txOptions = {
    ...SERIALIZABLE_TRANSACTION_OPTIONS,
    ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
  };

  for (let attempt = 1; attempt <= MAX_TRANSACTION_RETRIES; attempt += 1) {
    try {
      return await db.$transaction(guarded, txOptions);
    } catch (error) {
      if (!isSerializationConflict(error) || attempt === MAX_TRANSACTION_RETRIES) {
        throw error;
      }
      log.warn(
        { err: error, attempt, label },
        "Conflito Serializable — tentando novamente",
      );
      const base = RETRY_BASE_DELAY_MS * attempt;
      await delay(base + Math.floor(Math.random() * base));
    }
  }
  throw new Error(`Falha inesperada em transação serializável (${label}).`);
}
