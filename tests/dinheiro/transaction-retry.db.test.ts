import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@/src/generated/prisma/client";
import { createTestDb, type TestDb } from "../helpers/db";
import { runSerializableTransaction } from "@/src/services/shared/transaction";

/**
 * O retry de conflito Serializable, contra CONCORRÊNCIA REAL.
 *
 * O mesmo conflito chega em formas diferentes conforme a versão do Prisma (não
 * só `P2034`), e se a detecção não reconhecer uma delas o retry que protege o
 * ledger financeiro e a detecção de duplicata morre em silêncio.
 *
 * Um teste que simulasse o erro construindo o objeto à mão continuaria verde —
 * ele codificaria uma forma fixa. Só forçar o conflito no Postgres de verdade
 * prova que a detecção acompanha o driver.
 */

let db: TestDb;

beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.dispose();
});
beforeEach(async () => {
  await db.reset();
});

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Duas transações Serializable com dependência read/write sobre o MESMO
 * predicado: o SSI do Postgres detecta o phantom-insert e aborta uma delas com
 * SQLSTATE 40001. É o padrão exato da detecção de duplicata do projeto.
 */
async function duasConcorrentes(
  escrever: (tx: Prisma.TransactionClient, id: string) => Promise<unknown>,
): Promise<{ sucessos: number; erros: unknown[] }> {
  const erros: unknown[] = [];
  let sucessos = 0;
  const rodar = async (id: string) => {
    try {
      await runSerializableTransaction("teste-conflito", async (tx) => {
        await tx.$queryRaw`SELECT count(*) FROM audit_events WHERE action = 'teste.conflito'`;
        await dormir(250);
        await escrever(tx, id);
      });
      sucessos += 1;
    } catch (err) {
      erros.push(err);
    }
  };
  await Promise.all([rodar("a"), rodar("b")]);
  return { sucessos, erros };
}

function descrever(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return `${err.code}: ${err.message.slice(0, 120)}`;
  }
  return `${(err as Error)?.name}: ${String((err as Error)?.message).slice(0, 120)}`;
}

describe("runSerializableTransaction sob conflito real", () => {
  it("retenta e conclui as DUAS quando o conflito vem de $executeRaw", async () => {
    // Caminho do `settlement_events`, que grava por `$executeRaw`.
    const { sucessos, erros } = await duasConcorrentes((tx, id) =>
      tx.$executeRaw`
        INSERT INTO audit_events ("id", "actor", "action", "resource", "resourceId", "details", "createdAt")
        VALUES (gen_random_uuid()::text, 'teste', 'teste.conflito', 'teste', ${id}, '{}'::jsonb, now())
      `,
    );
    expect(erros.map(descrever)).toEqual([]);
    expect(sucessos).toBe(2);
    expect(
      await db.prisma.auditEvent.count({ where: { action: "teste.conflito" } }),
    ).toBe(2);
  });

  it("retenta e conclui as DUAS quando o conflito vem do cliente Prisma", async () => {
    // Forma diferente da anterior (DriverAdapterError cru, sem código Prisma);
    // as duas precisam ser reconhecidas pela MESMA função.
    const { sucessos, erros } = await duasConcorrentes((tx, id) =>
      tx.auditEvent.create({
        data: {
          actor: "teste",
          action: "teste.conflito",
          resource: "teste",
          resourceId: id,
          details: {},
        },
      }),
    );
    expect(erros.map(descrever)).toEqual([]);
    expect(sucessos).toBe(2);
  });

  it("erro que NÃO é conflito sobe na primeira tentativa, sem gastar retry", async () => {
    let tentativas = 0;
    await expect(
      runSerializableTransaction("teste-erro-real", async () => {
        tentativas += 1;
        throw new Error("erro de negócio");
      }),
    ).rejects.toThrow("erro de negócio");
    expect(tentativas).toBe(1);
  });
});
