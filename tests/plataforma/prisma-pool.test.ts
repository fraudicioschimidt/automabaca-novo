import { describe, expect, it } from "vitest";
import {
  DB_QUERY_TIMEOUT_MS,
  DB_STATEMENT_TIMEOUT_MS,
  pgPool,
} from "@/src/infra/prisma";

describe("pool PostgreSQL", () => {
  it("cancela statements presos no servidor antes do timeout cliente", () => {
    expect(pgPool.options.statement_timeout).toBe(DB_STATEMENT_TIMEOUT_MS);
    expect(pgPool.options.query_timeout).toBe(DB_QUERY_TIMEOUT_MS);
    expect(DB_STATEMENT_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    expect(DB_QUERY_TIMEOUT_MS).toBeGreaterThan(DB_STATEMENT_TIMEOUT_MS);
  });
});
