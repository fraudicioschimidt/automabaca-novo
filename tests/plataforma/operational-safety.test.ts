import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scanDestructiveOps } from "@/scripts/check-destructive-ops.mjs";
import { safeRemoveTreeSync } from "@/scripts/lib/safe-fs.mjs";

describe("barreiras operacionais", () => {
  it("mantém remoção recursiva centralizada e verificada no repositório", async () => {
    expect(scanDestructiveOps().violations).toEqual([]);

    const projectRoot = await realpath(new URL("../..", import.meta.url));
    expect(() => safeRemoveTreeSync(projectRoot, resolve(projectRoot, ".git")))
      .toThrow("fora da lista de artefatos removíveis");
    expect(() => safeRemoveTreeSync(projectRoot, resolve(projectRoot, "src")))
      .toThrow("fora da lista de artefatos removíveis");
  });
});
