import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { assertRuntimeConnectionIsUnprivileged } from "@/src/infra/runtime-db-role";

let admin: Pool;

beforeAll(() => {
  admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
});
afterAll(async () => {
  await admin.end();
});

describe("fail-fast de boot contra o PostgreSQL real", () => {
  it("a role administrativa da suíte é recusada como runtime de produção", async () => {
    await expect(assertRuntimeConnectionIsUnprivileged(admin, {
      nodeEnv: "production",
      env: { NODE_ENV: "production" },
    })).rejects.toThrow(/role privilegiada/);
  });
});
