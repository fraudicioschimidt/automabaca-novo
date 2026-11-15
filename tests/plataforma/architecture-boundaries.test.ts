import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "../helpers/source-files";
import { dependencyGraph, forbiddenClientDependencies, runtimeCycles } from "../helpers/dependency-graph";

const ROOT = process.cwd();

const graph = dependencyGraph(new Map(
  ["src", "app"].flatMap((root) => sourceFiles(root))
    .filter((file) => !file.includes("/src/generated/"))
    .map((file) => [path.relative(ROOT, file).replaceAll(path.sep, "/"), readFileSync(file, "utf8")]),
));

function forbiddenImports(relativeRoot: string, forbidden: RegExp): string[] {
  return [...graph].filter(([file]) => file.startsWith(`${relativeRoot}/`))
    .flatMap(([file, module]) => module.dependencies
      .filter((edge) => forbidden.test(`@/${edge.target}`))
      .map((edge) => `${file} -> ${edge.target}`));
}

/**
 * Fonte com byte NULO vira BINÁRIO para o git: `git diff` imprime só "Binary
 * files differ", e some a revisão, o blame e o grep — e neste projeto o diff é
 * a ÚNICA revisão que existe. Um NUL cru usado como separador de chave basta.
 * O caractere continua permitido; cru no arquivo, não.
 */
function binaryLookingSources(): string[] {
  return ["app", "src", "scripts", "tests"]
    .flatMap((raiz) => sourceFiles(raiz))
    .filter((absolute) => !path.relative(ROOT, absolute).replaceAll(path.sep, "/").startsWith("src/generated/"))
    .filter((absolute) => readFileSync(absolute).includes(0))
    .map((absolute) => path.relative(ROOT, absolute).replaceAll(path.sep, "/"));
}

function parallelQueriesInsideTransactions(): string[] {
  return sourceFiles("src")
    .filter((absolute) => !path.relative(ROOT, absolute).replaceAll(path.sep, "/").startsWith("src/generated/"))
    .flatMap((absolute) => {
      const source = readFileSync(absolute, "utf8");
      // Pré-filtro textual seguro: sem os dois símbolos não pode existir a
      // combinação proibida. Evita construir centenas de ASTs sob cobertura.
      if (!source.includes("$transaction") || !source.includes("Promise.all")) return [];
      const ast = ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true);
      const violations: string[] = [];
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "$transaction"
        ) {
          const callback = node.arguments[0];
          if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
            const client = callback.parameters[0]?.name;
            if (client && ts.isIdentifier(client)) {
              const inspect = (child: ts.Node) => {
                if (
                  ts.isCallExpression(child) &&
                  ts.isPropertyAccessExpression(child.expression) &&
                  ts.isIdentifier(child.expression.expression) &&
                  child.expression.expression.text === "Promise" &&
                  child.expression.name.text === "all"
                ) {
                  let usesTransactionClient = false;
                  const findClient = (candidate: ts.Node) => {
                    if (
                      ts.isPropertyAccessExpression(candidate) &&
                      ts.isIdentifier(candidate.expression) &&
                      candidate.expression.text === client.text
                    ) usesTransactionClient = true;
                    ts.forEachChild(candidate, findClient);
                  };
                  child.arguments.forEach(findClient);
                  if (usesTransactionClient) {
                    const line = ast.getLineAndCharacterOfPosition(child.getStart(ast)).line + 1;
                    violations.push(`${path.relative(ROOT, absolute).replaceAll(path.sep, "/")}:${line} (${client.text})`);
                  }
                }
                ts.forEachChild(child, inspect);
              };
              inspect(callback.body);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
      return violations;
    });
}

/**
 * Arquivo de teste de banco que abre conexão e não a fecha segura o processo
 * do vitest depois da suíte: quem cria o `TestDb` chama `dispose`, e quem usa
 * o Prisma singleton direto o desconecta.
 */
function dbTestsWithoutTeardown(): string[] {
  return sourceFiles("tests")
    .filter((absolute) => absolute.endsWith(".db.test.ts"))
    .filter((absolute) => {
      const source = readFileSync(absolute, "utf8");
      if (source.includes("createTestDb()")) return !source.includes(".dispose(");
      return source.includes('import { prisma } from "@/src/infra/prisma"') && !source.includes("prisma.$disconnect()");
    })
    .map((absolute) => path.relative(ROOT, absolute).replaceAll(path.sep, "/"));
}

/**
 * A ponte Rust entra só pelo nome do pacote e pelo default. O nome deixa o
 * bundler escolher o lado (WebAssembly no navegador, N-API no servidor): um
 * caminho interno levaria o `.node` ao cliente. E o default é o único nome que
 * o ESM do Node enxerga no CommonJS do servidor: um import nomeado passa no
 * vitest e no Next, mas chega `undefined` ao worker de produção. A exceção é
 * o teste da própria ponte, que carrega cada lado pelo caminho.
 */
function bridgeImportViolations(): string[] {
  const doPacote = (specifier: string) => specifier === "@automabaca/dominio"
    || specifier.startsWith("@automabaca/dominio/") || specifier.includes("rust/crates/ponte");
  return ["app", "src", "scripts", "tests"]
    .flatMap((raiz) => sourceFiles(raiz))
    .filter((absolute) => !absolute.endsWith(`${path.sep}tests${path.sep}plataforma${path.sep}ponte.test.ts`))
    .filter((absolute) => /@automabaca\/dominio|rust\/crates\/ponte/.test(readFileSync(absolute, "utf8")))
    .flatMap((absolute) => {
      const ast = ts.createSourceFile(absolute, readFileSync(absolute, "utf8"), ts.ScriptTarget.Latest, true);
      const violations: string[] = [];
      const visit = (node: ts.Node) => {
        const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
            || (ts.isIdentifier(node.expression) && node.expression.text === "require")) ? node.arguments[0] : undefined;
        if (specifier && ts.isStringLiteral(specifier) && doPacote(specifier.text)) {
          const defaultOnly = ts.isImportDeclaration(node) && specifier.text === "@automabaca/dominio"
            && node.importClause?.name !== undefined && node.importClause.namedBindings === undefined;
          if (!defaultOnly) violations.push(`${path.relative(ROOT, absolute).replaceAll(path.sep, "/")}: ${node.getText()}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
      return violations;
    });
}

describe("fronteiras arquiteturais", () => {
  it("mantém domínio independente das camadas externas e do Prisma", () => {
    expect(forbiddenImports("src/domain", /^@\/(src\/(infra|services|providers|jobs|telegram|generated)(?:\/|$)|@prisma\/)/)).toEqual([]);
  });

  it("impede providers e infraestrutura de dependerem de serviços", () => {
    expect(forbiddenImports("src/providers", /^@\/src\/(services|jobs|telegram)(?:\/|$)/)).toEqual([]);
    expect(forbiddenImports("src/infra", /^@\/src\/(services|providers|jobs|telegram)(?:\/|$)/)).toEqual([]);
  });

  it("impede serviços de dependerem de interfaces e da composição do worker", () => {
    expect(forbiddenImports("src/services", /^@\/src\/(telegram|jobs)(?:\/|$)/)).toEqual([]);
  });

  it("mantém persistência fora da borda Telegram", () => {
    expect(forbiddenImports("src/telegram", /^@\/src\/infra\/prisma(?:\.ts)?$/)).toEqual([]);
  });

  it("não paraleliza consultas no mesmo cliente de transação", () => {
    expect(parallelQueriesInsideTransactions()).toEqual([]);
  });

  it("mantém todo fonte legível pelo git — nenhum byte NULO cru", () => {
    expect(binaryLookingSources(), "fonte que o git trata como binário").toEqual([]);
  });

  it("todo teste de banco fecha a conexão que abriu", () => {
    expect(dbTestsWithoutTeardown()).toEqual([]);
  });

  it("impede dependências circulares de execução", () => {
    expect(runtimeCycles(graph)).toEqual([]);
  });

  it("mantém src independente da aplicação Next", () => {
    expect(forbiddenImports("src", /^@\/app(?:\/|$)/)).toEqual([]);
  });

  it("impede dependências transitivas do navegador em serviços e infraestrutura", () => {
    expect(forbiddenClientDependencies(graph)).toEqual([]);
  });

  it("importa a ponte Rust só pelo nome do pacote e pelo default", () => {
    expect(bridgeImportViolations()).toEqual([]);
  });
});
