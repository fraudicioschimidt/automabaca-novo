#!/usr/bin/env node
/**
 * Escolhe quais versões de imagem saem do registry.
 *
 * Cada integração na `main` publica duas imagens de ~250 MB comprimidas e o
 * plano dá 2 GB de pacotes: **o limite é espaço, não idade**. Um corte por
 * idade não protege (dez releases num dia estouram a cota com tudo recente),
 * então o corte é um teto duro: ficam as N mais recentes, o resto sai.
 *
 * **Isto não afeta rollback:** o `publish.py` usa a imagem anterior guardada
 * LOCALMENTE no servidor. O registry só serve para reconstruir uma release
 * noutra máquina; as mais antigas se reconstroem do commit.
 *
 *   gh api .../versions --paginate | node scripts/podar-versoes-do-registry.mjs
 *
 * Imprime um id por linha — as versões a apagar.
 */
import { fileURLToPath } from "node:url";

/**
 * Quantas versões ficam por imagem. Os 2 GB do plano são divididos entre
 * pacotes e artefatos da CI: 2 versões das duas imagens (~1 GB) mais os 3
 * artefatos `release-*` (~240 MB, podados no mesmo job) deixam folga para a
 * versão nova subir antes de a antiga sair. Com artefatos acumulados, o GitHub
 * recusa uploads. 2 versões bastam para reconstruir a release viva e a
 * anterior noutra máquina.
 */
export const MANTER = 2;

/** Artefatos `release-*` mantidos pelo job `imagens` do check.yml, ~80 MB cada. */
export const ARTEFATOS_DE_RELEASE_MANTIDOS = 3;

/**
 * Folga para os pedaços SEM etiqueta de uma publicação mantida. O push de uma
 * imagem sobe primeiro os manifests filhos e por último o índice etiquetado;
 * entre eles passam minutos.
 */
const FOLGA_DOS_FILHOS_MS = 60 * 60_000;

const etiquetas = (versao) => versao.metadata?.container?.tags ?? [];

/**
 * Ficam as `manter` publicações ETIQUETADAS mais recentes, com os pedaços dela.
 *
 * Um push não cria uma versão, cria várias: o índice etiquetado com o commit,
 * o manifest da imagem e, com o buildx padrão, um atestado — os dois últimos
 * sem etiqueta. Contar versões em vez de publicações apagaria o manifest de
 * uma imagem mantida e deixaria o índice apontando para o nada ("manifest not
 * found" no `docker pull` do deploy). Por isso: pedaço sem etiqueta só sai se
 * for mais antigo que a publicação mais velha que fica. Sem nenhuma versão
 * etiquetada, nada sai.
 */
export function versoesParaApagar(versoes, { manter = MANTER } = {}) {
  const quando = (v) => Date.parse(v.created_at);
  const ordenadas = [...versoes].sort((a, b) => quando(b) - quando(a));
  const mantidas = ordenadas.filter((v) => etiquetas(v).length > 0).slice(0, manter);
  if (mantidas.length === 0) return [];
  const ficam = new Set(mantidas.map((v) => v.id));
  const corte = quando(mantidas.at(-1)) - FOLGA_DOS_FILHOS_MS;
  return ordenadas
    .filter((v) => !ficam.has(v.id))
    .filter((v) => etiquetas(v).length > 0 || quando(v) < corte)
    .map((v) => v.id);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const entrada = [];
  for await (const pedaco of process.stdin) entrada.push(pedaco);
  const versoes = JSON.parse(Buffer.concat(entrada).toString("utf8"));
  if (!Array.isArray(versoes)) {
    process.stderr.write("esperava uma lista de versões na entrada padrão\n");
    process.exit(1);
  }
  const alvos = versoesParaApagar(versoes);
  process.stderr.write(`${versoes.length} versões no registry; mantendo ${MANTER}, apagando ${alvos.length}\n`);
  for (const id of alvos) process.stdout.write(`${id}\n`);
}
