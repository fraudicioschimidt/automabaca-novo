import path from "node:path";
import ts from "typescript";

export type Dependency = { specifier: string; target: string; typeOnly: boolean };
export type SourceModule = { dependencies: Dependency[]; client: boolean; server: boolean };
export type DependencyGraph = Map<string, SourceModule>;

function isTypeOnly(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node)) {
    return node.isTypeOnly || Boolean(node.exportClause && ts.isNamedExports(node.exportClause)
      && node.exportClause.elements.length && node.exportClause.elements.every((item) => item.isTypeOnly));
  }
  const clause = node.importClause;
  return Boolean(clause?.isTypeOnly || (clause && !clause.name && clause.namedBindings
    && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length
    && clause.namedBindings.elements.every((item) => item.isTypeOnly)));
}

function resolveTarget(file: string, specifier: string, sources: ReadonlyMap<string, string>): string {
  const base = specifier.startsWith("@/") ? specifier.slice(2)
    : specifier.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
      : specifier;
  const stems = /\.[cm]?jsx?$/.test(base) ? [base.replace(/\.[cm]?jsx?$/, ""), base] : [base];
  return stems.flatMap((stem) => [stem, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx", "/index.js"]
    .map((extension) => stem + extension)]).find((candidate) => sources.has(candidate)) ?? base;
}

/** Lê sintaxe real: comentários, imports relativos, reexports e tipos não se confundem. */
export function dependencyGraph(sources: ReadonlyMap<string, string>): DependencyGraph {
  const graph: DependencyGraph = new Map();
  for (const [file, source] of sources) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const directives = new Set<string>();
    for (const statement of ast.statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
      directives.add(statement.expression.text);
    }
    const dependencies: Dependency[] = [];
    const add = (specifier: ts.Node | undefined, typeOnly: boolean) => {
      if (!specifier || !ts.isStringLiteralLike(specifier)) return;
      dependencies.push({ specifier: specifier.text, target: resolveTarget(file, specifier.text, sources), typeOnly });
    };
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        add(node.moduleSpecifier, isTypeOnly(node));
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        add(node.moduleReference.expression, node.isTypeOnly);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        add(node.argument.literal, true);
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        add(node.arguments[0], false);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    graph.set(file, { dependencies, client: directives.has("use client"), server: directives.has("use server") });
  }
  return graph;
}

/** Componentes fortemente conexos; cada ciclo é reportado uma única vez. */
export function runtimeCycles(graph: DependencyGraph): string[][] {
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const active = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let index = 0;
  const visit = (file: string) => {
    indices.set(file, index);
    low.set(file, index++);
    stack.push(file);
    active.add(file);
    const dependencies = graph.get(file)?.dependencies.filter((edge) => !edge.typeOnly && graph.has(edge.target)) ?? [];
    for (const { target } of dependencies) {
      if (!indices.has(target)) {
        visit(target);
        low.set(file, Math.min(low.get(file)!, low.get(target)!));
      } else if (active.has(target)) {
        low.set(file, Math.min(low.get(file)!, indices.get(target)!));
      }
    }
    if (indices.get(file) !== low.get(file)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      active.delete(member);
      component.push(member);
    } while (member !== file);
    if (component.length > 1 || dependencies.some((edge) => edge.target === file)) cycles.push(component.sort());
  };
  for (const file of graph.keys()) if (!indices.has(file)) visit(file);
  return cycles;
}

/** Segue inclusive helpers sem diretiva; Server Actions são fronteiras RPC do Next. */
export function forbiddenClientDependencies(graph: DependencyGraph): string[] {
  const forbidden = /^(?:src\/(?:infra|services|providers|jobs|telegram|generated)(?:\/|$)|server-only$|node:|@prisma\/|pg(?:-boss)?$|next\/(?:headers|cache|server)$)/;
  const violations: string[] = [];
  for (const [root, module] of graph) {
    if (!module.client) continue;
    const visited = new Set<string>();
    const visit = (file: string, route: string[]) => {
      if (visited.has(file)) return;
      visited.add(file);
      for (const edge of graph.get(file)?.dependencies ?? []) {
        if (edge.typeOnly || graph.get(edge.target)?.server) continue;
        const next = [...route, edge.target];
        if (forbidden.test(edge.target)) violations.push(next.join(" -> "));
        else if (graph.has(edge.target)) visit(edge.target, next);
      }
    };
    visit(root, [root]);
  }
  return violations;
}
