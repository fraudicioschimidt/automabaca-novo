import { test, expect } from '@playwright/test';
import { prisma } from '@/src/infra/prisma';
import { addAuthenticatedSession } from '@/tests/browser/helpers/authenticated-session';

test('recusa de liquidação antecipada explica a regra e preserva a aposta', async ({ context, page, baseURL }, testInfo) => {
  const database = new URL(process.env.DATABASE_URL!).pathname;
  if (!database.includes('_e2e')) throw new Error('Auditoria exige banco E2E isolado.');
  const suffix = `${Date.now()}`;
  const bankroll = await prisma.bankroll.create({
    data: { nome: 'Auditoria de recusa', slug: `audit-recusa-${suffix}`, sharpMode: 'OFF' },
  });
  const bet = await prisma.bet.create({
    data: {
      bankrollId: bankroll.id, data: new Date(Date.now() + 86_400_000),
      evento: 'Audit Home vs Audit Away', esporte: 'Soccer',
      sportResolutionStatus: 'CONFIRMED', sportResolvedAt: new Date(),
      mercado: 'Money Line – Match', selecao: 'Audit Home',
      odds: 2, stake: 1, valorUnidade: 20, source: 'audit',
    },
  });
  await addAuthenticatedSession({ context, baseURL: baseURL! });
  await page.goto(`/tipsters/${bankroll.slug}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Alterar resultado de Audit Home contra Audit Away' }).click();
  await page.getByRole('button', { name: 'Ganha', exact: true }).click();
  const refusal = page.getByText("Este evento é futuro. Aguarde o início do evento para registrar o resultado.");
  await expect(refusal).toBeVisible();
  await expect(page.getByText(/An error occurred in the Server Components render/)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('recusa-explicada.png') });
  const after = await prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
  expect(after.status).toBe('PENDING');
  expect(Number(after.lucro)).toBe(0);
});
