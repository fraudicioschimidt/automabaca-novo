import "dotenv/config";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { seedMercados } from "./seed-mercados";

/**
 * Seed idempotente da taxonomia de mercados, versionada no registro canônico
 * `src/domain/mercados/catalog-data.ts`.
 * Re-rodável: upsert por chave natural, nunca duplica.
 *
 * Só para desenvolvimento: sem simular nem auditar, recolocaria em produção o
 * alias que o dono tirou.
 */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production" || process.env.AUTOMABACA_PROCESS) {
    console.error("Seed recusado em produção. O catálogo chega lá por "
      + "`node dist/ops-sincronizar-mercados.mjs --executor agent:<nome>:por:<dono>`, que simula antes e audita.");
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL não configurada.");
  const pool = new Pool({ connectionString: url, max: 3 });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    const { mercados, aliases } = await seedMercados(prisma);
    console.warn(`Seed ok: ${mercados} mercados, ${aliases} aliases.`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Seed falhou:", err);
  process.exit(1);
});
