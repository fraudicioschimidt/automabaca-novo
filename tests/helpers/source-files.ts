import { readdirSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const EXTENSOES_DE_CODIGO = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

/**
 * Arquivos-fonte sob um diretório do repo, recursivo. Vive aqui porque mais de
 * um portão estrutural varre a árvore — duas cópias divergiriam na extensão que
 * uma delas esquecesse de incluir.
 *
 * `extensions` existe porque a lista padrão descreve CÓDIGO, e nem todo portão
 * fala de código: `layout-estavel-em-captura` procura `content-visibility` em
 * CSS. Filtrar `.css` sobre um resultado que nunca contém um compara `[]` com
 * `[]`, e o portão não tem como reprovar nada.
 * Um caminhador que devolve só o que ELE decidiu ser "fonte" transforma
 * qualquer filtro do chamador em silêncio; pedir a extensão explicitamente é o
 * que impede o próximo filtro vazio.
 */
export function sourceFiles(
  relativeRoot: string,
  options: { extensions?: readonly string[] } = {},
): string[] {
  const extensions = new Set(options.extensions ?? EXTENSOES_DE_CODIGO);
  const absoluteRoot = path.join(ROOT, relativeRoot);
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (extensions.has(path.extname(entry.name))) files.push(absolute);
    }
  };
  visit(absoluteRoot);
  return files;
}
