import "server-only";
import { prisma } from "@/src/infra/prisma";
import { Prisma } from "@/src/generated/prisma/client";
import { bankrollIdentityLabels } from "@/src/domain/bankroll-identity";
import { roiPct } from "@/src/domain/analyzer/shared";
import { toNumber } from "@/src/domain/money";
import { FINAL_BET_STATUSES } from "@/src/domain/bet-status";
import { canonicalSport } from "@/src/domain/sports/registry";
import { UNKNOWN_SPORT, UNKNOWN_SPORT_LABEL } from "@/src/domain/sports/detect";
import { normalizeStr } from "@/src/domain/text";
import { analyzerDateFilter, analyzerWindowWhere, ANALYZER_PAGE_SIZE, type AnalyzerQuery } from "@/src/domain/analyzer-query";
import {
  ANALYZER_ROW_SELECT,
  mapAnalyzerRow,
  mapPortfolioRow,
  MAX_INTERACTIVE_ANALYTICS_ROWS,
  PORTFOLIO_ROW_SELECT,
} from "./bet-rows";

/** O esporte digitado como está gravado; "A confirmar", o nome que o painel mostra, é o não identificado. */
function storedSport(typed: string): string {
  const key = normalizeStr(typed);
  if (key === normalizeStr(UNKNOWN_SPORT) || key === normalizeStr(UNKNOWN_SPORT_LABEL)) return UNKNOWN_SPORT;
  return canonicalSport(typed) ?? typed;
}

type Tx = Prisma.TransactionClient;

/**
 * O nome de cada banca na carteira. Nome não é único: o repetido leva o slug,
 * senão duas bancas viram um canal só na dimensão Canal.
 */
async function bankrollNames(tx: Tx): Promise<Map<string, string>> {
  const banks = await tx.bankroll.findMany({ select: { id: true, nome: true, slug: true }, orderBy: { slug: "asc" } });
  return bankrollIdentityLabels(banks);
}

/**
 * Um snapshot sustenta volume, resumo e página; o detalhe inclui o período anterior.
 *
 * Sem `bankrollId` é a carteira: todas as bancas, com stake e lucro em reais
 * pelo valor da unidade gravado em cada aposta, e a banca de cada aposta.
 */
export async function readAnalyzer(bankrollId: string | null, query: AnalyzerQuery, today: string) {
  // O filtro é digitado: o esporte aceita o nome que o painel mostra ("Futebol")
  // e a casa não diferencia maiúsculas, senão o recorte volta vazio sem aviso.
  // No PostgreSQL o `equals` insensível do Prisma vira ILIKE sem escape: "%" e "_"
  // seriam curingas e uma barra invertida no fim derrubaria a consulta.
  const casaPattern = query.casa.replace(/[\\%_]/g, "\\$&");
  const base = {
    ...(bankrollId === null ? {} : { bankrollId }), deletedAt: null,
    ...(query.esporte ? { esporte: storedSport(query.esporte) } : {}),
    ...(query.casa ? { casaDeAposta: { equals: casaPattern, mode: "insensitive" as const } } : {}),
  };
  return prisma.$transaction(async (tx) => {
    const names = bankrollId === null ? await bankrollNames(tx) : null;
    const readRows = async (args: Pick<Prisma.BetFindManyArgs, "where" | "orderBy" | "skip" | "take">) => {
      if (!names) return (await tx.bet.findMany({ ...args, select: ANALYZER_ROW_SELECT })).map(mapAnalyzerRow);
      const rows = await tx.bet.findMany({ ...args, select: PORTFOLIO_ROW_SELECT });
      return rows.map((row) => mapPortfolioRow(row, names.get(row.bankrollId) ?? ""));
    };
    const detailWhere = { ...base, ...analyzerWindowWhere(query.periodo, today, true) };
    const count = await tx.bet.count({ where: detailWhere });
    if (count <= MAX_INTERACTIVE_ANALYTICS_ROWS) {
      const rows = await readRows({ where: detailWhere, orderBy: [{ data: "asc" }, { id: "asc" }] });
      return { rows, largeHistory: null };
    }
    const where = { ...base, ...analyzerWindowWhere(query.periodo, today) };
    const total = await tx.bet.count({ where });
    let resolved: number;
    let stake: number;
    let profit: number;
    if (names) {
      const window = analyzerDateFilter(query.periodo, today);
      // A linha da carteira arredonda cada conversão a seis casas. Somar as
      // unidades antes de converter não conserva esse total. Agrega no banco
      // sem carregar o histórico; finais não têm a exceção de pendente futura.
      const [final] = await tx.$queryRaw<Array<{ resolved: number; stake: Prisma.Decimal; profit: Prisma.Decimal }>>(Prisma.sql`
        SELECT count(*)::int AS resolved,
          COALESCE(sum(round(stake * "valorUnidade", 6)), 0) AS stake,
          COALESCE(sum(round(lucro * "valorUnidade", 6)), 0) AS profit
        FROM bets WHERE "deletedAt" IS NULL AND status IN (${Prisma.join(FINAL_BET_STATUSES)})
          ${base.esporte ? Prisma.sql`AND esporte = ${base.esporte}` : Prisma.empty}
          ${query.casa ? Prisma.sql`AND "casaDeAposta" ILIKE ${casaPattern}` : Prisma.empty}
          ${window ? Prisma.sql`AND data >= ${window.gte} AND data < ${window.lt}` : Prisma.empty}
      `);
      resolved = final!.resolved;
      stake = toNumber(final!.stake);
      profit = toNumber(final!.profit);
    } else {
      const final = await tx.bet.aggregate({
        where: { ...where, status: { in: [...FINAL_BET_STATUSES] } },
        _count: { _all: true }, _sum: { stake: true, lucro: true },
      });
      resolved = final._count._all;
      stake = toNumber(final._sum.stake ?? 0);
      profit = toNumber(final._sum.lucro ?? 0);
    }
    const dates = await tx.bet.aggregate({ where, _min: { data: true }, _max: { data: true } });
    const pending = await tx.bet.count({ where: { ...where, status: "PENDING" } });
    const pages = Math.max(1, Math.ceil(total / ANALYZER_PAGE_SIZE));
    const page = Math.min(query.pagina, pages);
    const rows = await readRows({
      where, orderBy: [{ data: "desc" }, { id: "desc" }],
      skip: (page - 1) * ANALYZER_PAGE_SIZE, take: ANALYZER_PAGE_SIZE,
    });
    return {
      rows: [],
      largeHistory: {
        firstDate: dates._min.data, lastDate: dates._max.data,
        total, resolved, pending, stake, profit,
        roi: roiPct(profit, stake),
        page, pages, rows,
      },
    };
  }, { isolationLevel: "RepeatableRead", timeout: 20_000 });
}
