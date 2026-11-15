import { describe, expect, it } from "vitest";
import { dependencyGraph, forbiddenClientDependencies, runtimeCycles } from "../helpers/dependency-graph";

describe("detector de dependências", () => {
  it("resolve imports relativos, efeitos colaterais, reexports, require e import dinâmico", () => {
    const graph = dependencyGraph(new Map([
      ["src/domain/a.ts", `// import "ignored"\nimport "../infra/db"; export { x } from "./b"; const c = require("./c"); const d = import("./d");`],
      ["src/infra/db.ts", ""], ["src/domain/b.ts", ""], ["src/domain/c.ts", ""], ["src/domain/d.ts", ""],
    ]));
    expect(graph.get("src/domain/a.ts")?.dependencies.map((edge) => edge.target)).toEqual([
      "src/infra/db.ts", "src/domain/b.ts", "src/domain/c.ts", "src/domain/d.ts",
    ]);
  });

  it("detecta ciclos de execução sem confundir referências de tipos", () => {
    const graph = dependencyGraph(new Map([
      ["a.ts", `import { b } from "./b"; import type { C } from "./c";`],
      ["b.ts", `export { a } from "./a";`],
      ["c.ts", `import { type A } from "./a"; export type { B } from "./b";`],
    ]));
    expect(runtimeCycles(graph)).toEqual([["a.ts", "b.ts"]]);
    expect(graph.get("c.ts")?.dependencies.every((edge) => edge.typeOnly)).toBe(true);
  });

  it("encontra infraestrutura escondida atrás de helper client e permite Server Action", () => {
    const graph = dependencyGraph(new Map([
      ["app/component.tsx", `"use client"; import "./helper"; import { save } from "./actions"; import type { Row } from "../src/services/query";`],
      ["app/helper.ts", `import "../src/infra/db";`],
      ["app/actions.ts", `"use server"; import "../src/infra/db";`],
      ["src/infra/db.ts", ""], ["src/services/query.ts", ""],
    ]));
    expect(forbiddenClientDependencies(graph)).toEqual(["app/component.tsx -> app/helper.ts -> src/infra/db.ts"]);
  });
});
