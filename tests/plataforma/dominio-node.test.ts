import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import dominio from "@automabaca/dominio-node";

describe("ponte N-API do crate dominio", () => {
  it("carrega o binário compilado deste workspace", () => {
    const cargo = readFileSync("rust/Cargo.toml", "utf8");
    const versaoDoWorkspace = /\[workspace\.package\][^[]*?\nversion = "([^"]+)"/.exec(cargo)?.[1];
    expect(versaoDoWorkspace).toMatch(/^\d+\.\d+\.\d+$/);
    expect(dominio.versao()).toBe(versaoDoWorkspace);
  });
});
