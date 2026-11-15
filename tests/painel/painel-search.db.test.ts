import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { searchPanel } from "@/src/services/painel/search";

/**
 * O `contains` insensível do Prisma vira ILIKE no PostgreSQL: o texto digitado
 * na busca é literal, não padrão de LIKE.
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
  for (const [nome, slug] of [["Banca A", "banca-a"], ["Banca_B", "banca-b"], ["100% Green", "green"], ["Pasta C:\\", "pasta"]]) {
    await db.prisma.bankroll.create({ data: { nome: nome!, slug: slug! } });
  }
});

async function bancas(query: string): Promise<string[]> {
  return (await searchPanel(query)).filter((row) => row.kind === "Tipster").map((row) => row.title).sort();
}

describe("searchPanel (Postgres real)", () => {
  it("% e _ digitados são literais, não curingas", async () => {
    expect(await bancas("%")).toEqual(["100% Green"]);
    expect(await bancas("_")).toEqual(["Banca_B"]);
    expect(await bancas("banca")).toEqual(["Banca A", "Banca_B"]);
  });

  it("barra invertida no fim acha o texto e não derruba a consulta", async () => {
    expect(await bancas("C:\\")).toEqual(["Pasta C:\\"]);
  });
});
