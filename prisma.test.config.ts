import { defineConfig } from "prisma/config";
import { resolveDisposableMigrationUrl } from "./scripts/lib/test-migration-url";

// Sem dotenv: este processo só pode migrar o destino declarado pelo runner.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: resolveDisposableMigrationUrl(process.env) },
});
