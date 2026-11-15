import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@/src/generated/prisma/client";
import { registrarMovimentacaoManual } from "@/src/services/contas/manage";

describe("cliente da reconciliação de movimentos concorrentes", () => {
  it("consulta a movimentação vencedora no mesmo cliente injetado", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      contaId: "conta", tipo: "DEPOSITO", valor: new Prisma.Decimal(10), saldoApos: new Prisma.Decimal(110),
    });
    const tx = { movimentacao: { findUnique } } as unknown as Prisma.TransactionClient;
    let attempts = 0;
    const client = {
      async $transaction<T>(operation: (db: Prisma.TransactionClient) => Promise<T>): Promise<T> {
        if (attempts++ === 0) {
          throw new Prisma.PrismaClientKnownRequestError("duplicate", {
            code: "P2002", clientVersion: "test", meta: { target: ["clientMutationId"] },
          });
        }
        return operation(tx);
      },
    };
    await expect(registrarMovimentacaoManual({
      contaId: "conta", tipo: "DEPOSITO", valor: 10, clientMutationId: "movimento-123",
    }, { client })).resolves.toEqual({ saldoApos: 110, deduplicado: true });
    expect(findUnique).toHaveBeenCalledWith({
      where: { clientMutationId: "movimento-123" },
      select: { contaId: true, tipo: true, valor: true, saldoApos: true },
    });
    expect(attempts).toBe(2);
  });
});
