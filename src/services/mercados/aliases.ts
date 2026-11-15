import { normalizeMercadoKey } from "@/src/domain/mercados/catalog";
import { prisma } from "@/src/infra/prisma";
import {
  runSerializableTransaction,
  type SerializableTransactionClient,
} from "@/src/services/shared/transaction";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";

/**
 * Curadoria de aliases de mercado (Config → admin). Caso de uso com I/O —
 * a borda `app/` não toca a tabela direto (espelha o TeamAlias em
 * `services/painel/aliases`). A normalização canônica do alias vive em
 * `domain/mercados` (uma implementação por conceito).
 */

/**
 * Cadastra/atualiza um alias de mercado para o mercado padrão informado. Alias
 * de mercado é MANUAL por construção (ver o schema): a auditoria na mesma
 * transação é o que prova quem ensinou.
 */
export async function adicionarMercadoAlias(params: {
  mercadoPadraoId: string;
  alias: string;
  actor: string;
}, options?: { client?: SerializableTransactionClient }): Promise<void> {
  const alias = params.alias.trim();
  const aliasNormalizado = normalizeMercadoKey(alias);
  if (!aliasNormalizado) {
    throw new RecusaDeNegocioError("Alias de mercado vazio — informe um texto não-trivial.");
  }
  await runSerializableTransaction("adicionarMercadoAlias", async (tx) => {
    const lockKey = `mercado-alias:${aliasNormalizado}|`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    // Só mercado ativo conta como destino, como na normalização: a cópia num
    // mercado desligado é inerte e a Config não a mostra para o dono remover.
    const existing = await tx.mercadoAlias.findMany({
      where: { aliasNormalizado, casaDeAposta: "", mercadoPadrao: { ativo: true } },
      select: { id: true, mercadoPadraoId: true, mercadoPadrao: { select: { nome: true } } },
    });
    const other = existing.find((row) => row.mercadoPadraoId !== params.mercadoPadraoId);
    if (other) {
      throw new RecusaDeNegocioError(
        `Alias "${alias}" já aponta para "${other.mercadoPadrao.nome}" — remova o conflito antes de reatribuir.`,
      );
    }
    const same = existing[0];
    const saved = same
      ? await tx.mercadoAlias.update({ where: { id: same.id }, data: { alias }, select: { id: true } })
      : await tx.mercadoAlias.create({
        data: {
          alias,
          aliasNormalizado,
          casaDeAposta: "",
          mercadoPadraoId: params.mercadoPadraoId,
        },
        select: { id: true },
      });
    await tx.auditEvent.create({
      data: {
        actor: params.actor,
        action: "market_alias.create",
        resource: "market_alias",
        resourceId: saved.id,
        details: { alias, aliasNormalizado, mercadoPadraoId: params.mercadoPadraoId, existed: Boolean(same) },
      },
    });
  }, { client: options?.client ?? prisma });
}

/** Remove um alias de mercado por id; a auditoria guarda o que foi apagado. */
export async function removerMercadoAlias(aliasId: string, actor: string): Promise<void> {
  await runSerializableTransaction("removerMercadoAlias", async (tx) => {
    const removed = await tx.mercadoAlias.delete({ where: { id: aliasId } });
    await tx.auditEvent.create({
      data: {
        actor,
        action: "market_alias.delete",
        resource: "market_alias",
        resourceId: removed.id,
        details: { alias: removed.alias, aliasNormalizado: removed.aliasNormalizado, mercadoPadraoId: removed.mercadoPadraoId },
      },
    });
  });
}
