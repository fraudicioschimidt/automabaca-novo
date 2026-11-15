import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "../helpers/source-files";

/**
 * Portão: dead-letter usada como FIXTURE não convive com consumidor vivo.
 *
 * `registerQueue` faz duas coisas: cria a fila com sua DLQ e liga um watcher
 * na DLQ. O watcher é um worker de verdade: busca a próxima dead-letter e a
 * mantém em `active` enquanto processa. Com o boss producer-only
 * (`getSharedBoss`) ele varre a cada 2s — o `pollingInterval` padrão, já que
 * sem listener o backstop de NOTIFY não se aplica; com o boss completo
 * (`createBoss`) o NOTIFY do próprio `send` o acorda na hora. Quem chamou
 * `registerQueue` só para ter a fila leva o consumidor de brinde.
 *
 * O estrago: todo serviço de DLQ filtra `state IN ('created','retry','failed')`
 * — `active` não está na lista. Um teste que semeia dead-letter e depois lista
 * ou reenfileira compete com o próprio watcher, e perde de vez em quando: a
 * janela `active` dura dezenas de ms por job com a máquina ociosa, e cresce sob
 * a carga do gate. Comentário em cada arquivo não alcança quem escreve o
 * arquivo seguinte; por isso portão.
 *
 * A regra: num teste de banco, ou o arquivo NÃO liga consumidor de DLQ (use
 * `ensureQueueWithDeadLetter`, que cria a topologia sem `boss.work`), ou toda
 * dead-letter semeada nasce inelegível para entrega (`startAfter`).
 *
 * Deliberadamente conservador: o portão não tenta casar QUAL fila tem
 * consumidor com QUAL fila recebe fixture. Consumidor vivo no arquivo + fixture
 * entregável no arquivo já reprova — as duas saídas são baratas, e a corrida
 * que ele evita não é.
 *
 * Alcance: ele lê o ARQUIVO de teste. Um consumidor ligado dentro de um helper
 * compartilhado passaria despercebido — hoje nenhum liga, e o contrato de
 * `queues-deadletter.db.test.ts` (`getWipData` depois de criar a topologia) é
 * quem vigia o caminho que existe.
 */

const RAIZ = process.cwd();

type Analise = {
  /** Linhas que ligam um worker na `.dlq` (`registerQueue` ou `work` direto). */
  consumidores: number[];
  /** Linhas que semeiam dead-letter ENTREGÁVEL — a que o watcher rouba. */
  fixturesEntregaveis: number[];
};

/** A fila alvo é uma dead-letter? Vale o texto do argumento, não seu valor. */
function ehDeadLetter(argumento: string): boolean {
  return /dlq/i.test(argumento) || /deadLetterOf\s*\(/.test(argumento);
}

function analisar(nome: string, fonte: string): Analise {
  const sf = ts.createSourceFile(nome, fonte, ts.ScriptTarget.Latest, true);
  const consumidores: number[] = [];
  const fixturesEntregaveis: number[] = [];
  const linhaDe = (no: ts.Node) => sf.getLineAndCharacterOfPosition(no.getStart(sf)).line + 1;

  const visitar = (no: ts.Node): void => {
    if (ts.isCallExpression(no)) {
      const chamada = ts.isPropertyAccessExpression(no.expression)
        ? no.expression.name.text
        : ts.isIdentifier(no.expression)
          ? no.expression.text
          : "";
      const fila = no.arguments[0]?.getText(sf) ?? "";
      if (chamada === "registerQueue" || (chamada === "work" && ehDeadLetter(fila))) {
        consumidores.push(linhaDe(no));
      }
      // `send` multilinha é a forma comum aqui — daí AST em vez de regex.
      if (chamada === "send" && ehDeadLetter(fila)) {
        const opcoes = no.arguments[2]?.getText(sf) ?? "";
        if (!/\bstartAfter\b/.test(opcoes)) fixturesEntregaveis.push(linhaDe(no));
      }
    }
    ts.forEachChild(no, visitar);
  };
  visitar(sf);
  return { consumidores, fixturesEntregaveis };
}

const VAZIO: Analise = { consumidores: [], fixturesEntregaveis: [] };

/**
 * Só entra no parser quem PODE ter achado: sem `dlq` nem `registerQueue` no
 * texto, `ehDeadLetter` e a busca por consumidor reprovariam de qualquer jeito.
 * Não é heurística frouxa — é a mesma condição, cobrada antes.
 *
 * Memorizado porque montar a AST de todos os arquivos a cada teste leva ~15s
 * sob carga e estoura o `testTimeout` do projeto unit. Portão lento é portão
 * que ensina a rodar de novo — a doença que este arquivo existe para tratar.
 */
let cache: Array<{ rel: string; analise: Analise }> | null = null;

function testesDeBanco(): Array<{ rel: string; analise: Analise }> {
  cache ??= sourceFiles("tests")
    .filter((abs) => abs.endsWith(".db.test.ts"))
    .map((abs) => {
      const rel = path.relative(RAIZ, abs);
      const fonte = readFileSync(abs, "utf8");
      const podeTerAchado = /dlq|registerQueue/i.test(fonte);
      return { rel, analise: podeTerAchado ? analisar(rel, fonte) : VAZIO };
    });
  return cache;
}

describe("fixture de dead-letter vs consumidor vivo", () => {
  it("a varredura distingue fixture entregável de fixture inerte", () => {
    // Auto-verificação: sem isto o portão pode passar por estar cego.
    const analise = analisar(
      "sintetico.db.test.ts",
      [
        `await registerQueue(boss, fila);`,
        `await boss.send(deadLetterOf(fila), { a: 1 });`,
        `await boss.send(`,
        `  deadLetterOf(fila),`,
        `  { a: 1 },`,
        `  { startAfter: 3_600 },`,
        `);`,
        `await boss.send(fila, { a: 1 });`,
        `await boss.work(fila, {}, async () => {});`,
      ].join("\n"),
    );
    expect(analise.consumidores).toEqual([1]);
    expect(analise.fixturesEntregaveis).toEqual([2]);
  });

  it("a varredura enxerga os dois lados da regra na suíte real", () => {
    // Um glob quebrado deixaria o portão verde para sempre; estas duas
    // contagens só ficam de pé enquanto ele realmente lê a suíte.
    const arquivos = testesDeBanco();
    expect(arquivos.length).toBeGreaterThan(50);
    expect(arquivos.filter((a) => a.analise.consumidores.length > 0).map((a) => a.rel))
      .not.toEqual([]);
    expect(arquivos.filter((a) => a.analise.fixturesEntregaveis.length > 0).map((a) => a.rel))
      .not.toEqual([]);
  });

  it("nenhum teste de banco semeia dead-letter entregável com consumidor vivo", () => {
    const infracoes = testesDeBanco().flatMap(({ rel, analise }) => {
      if (analise.consumidores.length === 0) return [];
      return analise.fixturesEntregaveis.map(
        (linha) => `${rel}:${linha} (consumidor ligado na linha ${analise.consumidores[0]})`,
      );
    });
    expect(
      infracoes,
      "dead-letter semeada como fixture num arquivo que liga watcher — o watcher a busca,"
        + " ela fica em `active` e some do filtro `state IN ('created','retry','failed')`."
        + "\nSaídas: `ensureQueueWithDeadLetter` (cria a fila SEM consumidor) ou `startAfter`"
        + " no send (fixture inelegível para entrega).\n"
        + infracoes.map((i) => `  ${i}`).join("\n"),
    ).toEqual([]);
  });
});
