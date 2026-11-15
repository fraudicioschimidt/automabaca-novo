import "server-only";
import { Prisma } from "@/src/generated/prisma/client";
import {
  JANELA_DE_RENDIMENTO_MS,
  type PeriodoDeCusto,
  type RendimentoDeProvider,
  type TipoDeTrabalho,
} from "@/src/domain/rendimento-de-provider";
import { prisma } from "@/src/infra/prisma";
import { PROVIDER_CAPS, periodKeyFor } from "@/src/providers/budget-config";

export type ProviderBudgetRow = {
  name: string;
  /** Chave do período corrente do teto; null para provider sem teto. */
  period: string | null;
  /** Janela do GASTO (a do teto). A do rendimento são os 7 dias; a tela diz as duas. */
  janelaDoCusto: PeriodoDeCusto;
  /** Capacidade comprometida: faturada + reservada, para não exibir cota fictícia. */
  used: number;
  cap: number | null;
  label: string;
  /** O que o provider entregou nos últimos `JANELA_DE_RENDIMENTO_DIAS`. */
  rendimento: RendimentoDeProvider;
};

/**
 * Providers em uso, com o gasto do período corrente e o que entregaram na
 * janela de rendimento. Some da tela quem não consome há 7 dias; provider sem
 * teto entra sempre, porque não registra consumo e a ausência de linha não
 * prova ausência de uso.
 */
export async function getProviderBudgets(now: Date = new Date()): Promise<ProviderBudgetRow[]> {
  const currentPeriods = PROVIDER_CAPS.map((cap) => ({
    provider: cap.provider,
    periodKey: periodKeyFor(cap.period, now),
  }));
  const [rows, { rendimentoPorProvider, ativosRecentes }] = await Promise.all([
    prisma.providerBudget.findMany({
      where: { OR: currentPeriods },
      orderBy: [{ provider: "asc" }, { periodKey: "desc" }],
    }),
    getProvidersDaJanela(now),
  ]);
  return PROVIDER_CAPS.map((cap) => {
    const unlimited = !Number.isFinite(cap.cap);
    const periodKey = unlimited ? null : periodKeyFor(cap.period, now);
    const row = rows.find((b) => b.provider === cap.provider && b.periodKey === periodKey);
    return {
      name: cap.provider,
      period: periodKey,
      janelaDoCusto: cap.period,
      used: (row?.spent ?? 0) + (row?.reserved ?? 0),
      cap: unlimited ? null : cap.cap,
      label: cap.label,
      rendimento: rendimentoPorProvider.get(cap.provider) ?? {},
    };
  }).filter((b) => b.cap === null || ativosRecentes.has(b.name));
}

/**
 * O que cada provider entregou na janela, e quem apareceu nela. As duas
 * perguntas partilham o recorte de 7 dias que decide se a linha existe.
 *
 * Lê as três colunas de autoria (identidade, fechamento e resultado); o
 * `resultSnapshot IS NOT NULL` conta só a aposta em que o provider devolveu
 * observação, não a que foi apenas consultada.
 */
async function getProvidersDaJanela(now: Date): Promise<{
  rendimentoPorProvider: Map<string, RendimentoDeProvider>;
  ativosRecentes: Set<string>;
}> {
  const desdeRendimento = new Date(now.getTime() - JANELA_DE_RENDIMENTO_MS);

  const [entregas, consumidores] = await Promise.all([
    prisma.$queryRaw<Array<{ tipo: TipoDeTrabalho; provider: string; n: number }>>(Prisma.sql`
      SELECT 'identidade' AS tipo, s.provider AS provider, count(*)::int AS n
        FROM bet_sharp s JOIN bets b ON b.id = s."betId" AND b."deletedAt" IS NULL
       WHERE s.provider IS NOT NULL AND s."identityResolvedAt" >= ${desdeRendimento}
       GROUP BY 1, 2
      UNION ALL
      SELECT 'fechamento', c.provider, count(*)::int
        FROM bet_closing c JOIN bets b ON b.id = c."betId" AND b."deletedAt" IS NULL
       WHERE c.provider IS NOT NULL AND c."fetchedAt" >= ${desdeRendimento}
       GROUP BY 1, 2
      UNION ALL
      SELECT 'resultado', r."resultProvider", count(*)::int
        FROM bet_result r JOIN bets b ON b.id = r."betId" AND b."deletedAt" IS NULL
       WHERE r."resultProvider" IS NOT NULL
         AND r."resultSnapshot" IS NOT NULL
         AND r."resultCheckedAt" >= ${desdeRendimento}
       GROUP BY 1, 2
    `),
    // Recência, não "gastou no período corrente": o budget do bridgeodds é
    // horário e zera na virada, e o provider principal sumiria a cada hora cheia.
    prisma.providerBudget.findMany({
      where: { updatedAt: { gte: desdeRendimento } },
      select: { provider: true },
      distinct: ["provider"],
    }),
  ]);

  const rendimentoPorProvider = new Map<string, RendimentoDeProvider>();
  for (const linha of entregas) {
    const n = Number(linha.n);
    if (n <= 0) continue;
    rendimentoPorProvider.set(linha.provider, {
      ...rendimentoPorProvider.get(linha.provider),
      [linha.tipo]: n,
    });
  }

  return {
    rendimentoPorProvider,
    ativosRecentes: new Set(consumidores.map((row) => row.provider)),
  };
}
