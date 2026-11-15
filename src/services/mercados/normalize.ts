import type { Prisma } from "@/src/generated/prisma/client";
import { MERCADOS_FINAIS, isMercadoFinal, normalizeMercadoKey, resolveMercadoCanonical, resolveMercadoStatic } from "@/src/domain/mercados/catalog";
import { isMercadoFinalForSport } from "@/src/domain/mercados/compatibility";
import { pinnacleizeMercado } from "@/src/domain/mercados/finalize";
import { hasSportScoreUnitMismatch } from "@/src/domain/mercados/stat-qualifier";
import { canonicalSport } from "@/src/domain/sports/registry";
import { prisma as defaultPrisma } from "@/src/infra/prisma";

/**
 * Normalização de mercado com overlay de aliases do banco (gerenciados em
 * /config/mercados) sobre o catálogo estático.
 *
 * O catálogo é lido a cada chamada, sem cache de processo: a curadoria roda na
 * web e o ops-sincronizar-mercados em processo próprio, e a captura no worker
 * precisa ver a mudança já no post seguinte. São duas consultas pequenas.
 */

type MercadoCatalog = {
  /** key `${aliasNormalizado}|${casaNormalizada}` → todos os destinos ativos. */
  destinationsByKey: Map<string, string[]>;
  /** Catálogo materializado pelo seed: a partir daqui o banco governa aliases. */
  databaseAuthoritative: boolean;
};

/** Somente as leituras necessárias; aceita cliente normal, transação ou double. */
export type MercadoCatalogClient = Pick<Prisma.TransactionClient, "mercadoAlias" | "mercadoPadrao">;

async function loadCatalog(db: MercadoCatalogClient): Promise<MercadoCatalog> {
  const rows = await db.mercadoAlias.findMany({
    select: {
      aliasNormalizado: true,
      casaDeAposta: true,
      mercadoPadrao: { select: { nome: true, ativo: true } },
    },
  });
  const destinationSets = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.mercadoPadrao.ativo) continue;
    const casa = normalizeMercadoKey(row.casaDeAposta ?? "");
    const key = `${row.aliasNormalizado}|${casa}`;
    const destinations = destinationSets.get(key) ?? new Set<string>();
    destinations.add(row.mercadoPadrao.nome);
    destinationSets.set(key, destinations);
  }
  const destinationsByKey = new Map(
    [...destinationSets].map(([key, destinations]) => [
      key,
      [...destinations].sort((a, b) => a.localeCompare(b, "pt-BR")),
    ]),
  );
  // O seed materializa o catálogo numa transação só: um mercado final ativo no
  // banco prova que ele rodou. Exigir TODOS faria cada mercado novo do código,
  // que só chega ao banco no próximo seed, desligar a curadoria inteira.
  const activeFinalMarkets = await db.mercadoPadrao.findMany({
    where: { ativo: true, nome: { in: [...MERCADOS_FINAIS] } },
    select: { nome: true },
    take: 1,
  });
  const databaseAuthoritative = activeFinalMarkets.length > 0;
  return { destinationsByKey, databaseAuthoritative };
}

export type NormalizeMercadoResult = {
  mercado: string;
  /** false = não reconhecido ou conflitante; em ambos os casos preserva o texto recebido. */
  matched: boolean;
  /** Mais de um destino ativo para a mesma chave: nunca escolher pela ordem física. */
  aliasConflict?: {
    aliasNormalizado: string;
    casaDeAposta: string;
    destinos: string[];
  };
};

function isMatchedFinal(mercado: string, esporte?: string): boolean {
  return esporte
    ? isMercadoFinalForSport(mercado, esporte)
    : isMercadoFinal(mercado);
}

/**
 * Resolve o mercado bruto para o canônico Pinnacle:
 * nome canônico → alias do banco (casa específica > genérico) → tradução
 * estática somente no bootstrap, antes de o catálogo completo existir no DB.
 * Depois do seed, remover/reatribuir um alias na curadoria muda o comportamento
 * de verdade: o fallback de código não volta a sobrepor o banco.
 */
export async function normalizeMercado(
  raw: string,
  options?: { casaDeAposta?: string; esporte?: string; client?: MercadoCatalogClient },
): Promise<NormalizeMercadoResult> {
  const db = options?.client ?? defaultPrisma;
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { mercado: trimmed, matched: false };
  // Um alias não pode trocar gols por pontos, nem apagar uma unidade que o
  // placar desta modalidade não mede. O rótulo original conserva a evidência.
  // Esporte ainda não resolvido não contradiz unidade nenhuma: o rótulo
  // normaliza, e a confirmação do esporte renormaliza pela edição.
  if (canonicalSport(options?.esporte) && hasSportScoreUnitMismatch(trimmed, "", options?.esporte)) {
    return { mercado: trimmed, matched: false };
  }

  const canonicalHit = resolveMercadoCanonical(trimmed);
  if (canonicalHit) {
    const mercado = pinnacleizeMercado(canonicalHit, options?.esporte);
    return { mercado, matched: isMatchedFinal(mercado, options?.esporte) };
  }

  const key = normalizeMercadoKey(trimmed);
  const { destinationsByKey, databaseAuthoritative } = await loadCatalog(db);
  const casa = normalizeMercadoKey(options?.casaDeAposta ?? "");
  // A chave específica existente sempre vence a genérica, inclusive quando
  // está corrompida. Cair para o genérico esconderia justamente o conflito que
  // precisa de curadoria.
  const specific = casa ? destinationsByKey.get(`${key}|${casa}`) : undefined;
  const selectedCasa = specific ? casa : "";
  const destinations = specific ?? destinationsByKey.get(`${key}|`);
  if (destinations) {
    const finalized = [...new Set(
      destinations.map((destination) => pinnacleizeMercado(destination, options?.esporte)),
    )];
    if (finalized.length === 1) {
      const mercado = finalized[0]!;
      return { mercado, matched: isMatchedFinal(mercado, options?.esporte) };
    }
    return {
      mercado: trimmed,
      matched: false,
      aliasConflict: {
        aliasNormalizado: key,
        casaDeAposta: selectedCasa,
        destinos: [...destinations],
      },
    };
  }

  if (!databaseAuthoritative) {
    const staticHit = resolveMercadoStatic(trimmed);
    if (staticHit) {
      const mercado = pinnacleizeMercado(staticHit, options?.esporte);
      return { mercado, matched: isMatchedFinal(mercado, options?.esporte) };
    }
  }

  return { mercado: trimmed, matched: false };
}
