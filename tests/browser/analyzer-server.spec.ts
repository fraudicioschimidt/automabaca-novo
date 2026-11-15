import { expect, test } from "@playwright/test";
import { prisma } from "@/src/infra/prisma";
import { addAuthenticatedSession } from "./helpers/authenticated-session";
import { spDayKey } from "@/src/domain/dates";
import AxeBuilder from "@axe-core/playwright";

test("histórico grande abre, pagina e permite refinar sem perder a URL", async ({ page, context, baseURL }) => {
  test.setTimeout(75_000); // inclui seed de 25 mil linhas, navegação e WCAG mobile.
  if (!new URL(process.env.DATABASE_URL ?? "").pathname.endsWith("_e2e")) throw new Error("Banco E2E obrigatório.");
  const slug = `analyzer-large-${Date.now()}`;
  const bank = await prisma.bankroll.create({ data: { nome: "Histórico grande E2E", slug, sharpMode: "OFF" } });
  await prisma.$executeRaw`
    INSERT INTO bets (id, "bankrollId", data, evento, esporte, mercado, selecao, odds, stake,
      "sportResolvedAt", "updatedAt", status, lucro, "settledAt")
    SELECT ${slug} || '-' || n, ${bank.id}, '2025-01-01T12:00:00Z'::timestamptz, 'Antiga vs Visitante',
      'Soccer', 'Moneyline', 'Antiga', 2, 1, now(), now(), 'WON'::"BetStatus", 1, now()
    FROM generate_series(1, 25001) n`;
  await prisma.bet.create({ data: {
    bankrollId: bank.id, data: new Date(`${spDayKey(new Date())}T12:00:00-03:00`),
    evento: "Atual E2E vs Visitante", esporte: "Soccer", casaDeAposta: "Casa E2E",
    mercado: "Moneyline", selecao: "Atual E2E", odds: 2, stake: 1,
    sportResolvedAt: new Date(),
  } });
  await addAuthenticatedSession({ context, baseURL: baseURL! });
  const response = await page.goto(`/tipsters/${slug}/analyzer`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Resumo do período completo" })).toBeVisible();
  await expect(page.getByText("Página 1 de 501 · 25002 apostas")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .exclude("[data-brand-wordmark]").analyze();
  expect(a11y.violations).toEqual([]);
  await page.screenshot({ path: "artifacts/melhorias-2026-09-09/analyzer-large-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Próxima", exact: true }).click();
  await expect(page).toHaveURL(/pagina=2/);
  await expect(page.getByText("Página 2 de 501 · 25002 apostas")).toBeVisible();
  await page.getByRole("button", { name: "Últimos 7 dias", exact: true }).click();
  await expect(page).toHaveURL(/periodo=7d/);
  await expect(page.getByRole("heading", { name: "Resumo do período completo" })).toHaveCount(0);
  await expect(page.getByText("apostas no recorte", { exact: false })).toContainText("1 apostas no recorte");
  await page.getByLabel("Casa de aposta", { exact: true }).fill("Inexistente");
  await page.getByRole("button", { name: "Aplicar filtros", exact: true }).click();
  await expect(page).toHaveURL(/casa=Inexistente/);
  await expect(page.getByText("apostas no recorte", { exact: false })).toContainText("0 apostas no recorte");
  await page.goBack();
  await expect(page.getByText("apostas no recorte", { exact: false })).toContainText("1 apostas no recorte");
});

test("carteira junta as bancas em reais, abre em 90 dias e cruza canal × mercado", async ({ page, context, baseURL }) => {
  test.setTimeout(60_000);
  if (!new URL(process.env.DATABASE_URL ?? "").pathname.endsWith("_e2e")) throw new Error("Banco E2E obrigatório.");
  // A casa isola o recorte das apostas que os outros testes deixam no banco.
  const casa = `Casa carteira ${Date.now()}`;
  const alfa = await prisma.bankroll.create({ data: { nome: `Alfa ${casa}`, slug: `alfa-${Date.now()}`, valorUnidade: 50 } });
  const beta = await prisma.bankroll.create({ data: { nome: `Beta ${casa}`, slug: `beta-${Date.now()}`, valorUnidade: 20 } });
  const hoje = new Date(`${spDayKey(new Date())}T12:00:00-03:00`);
  const aposta = { data: hoje, evento: "Carteira vs Visitante", esporte: "Soccer", casaDeAposta: casa,
    mercado: "Money Line – Match", selecao: "Carteira", odds: 1.9, sportResolvedAt: hoje, settledAt: hoje };
  await prisma.bet.create({ data: { ...aposta, bankrollId: alfa.id, stake: 1, status: "WON", lucro: 0.9, valorUnidade: 50 } });
  await prisma.bet.create({ data: { ...aposta, bankrollId: beta.id, stake: 2, status: "LOST", lucro: -2, valorUnidade: 20 } });
  await addAuthenticatedSession({ context, baseURL: baseURL! });

  const response = await page.goto(`/analyzer?casa=${encodeURIComponent(casa)}`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: /Analyzer\s*· Carteira/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Últimos 90 dias", exact: true })).toHaveAttribute("aria-pressed", "true");
  // R$ 45,00 da Alfa (0,9u a R$ 50) menos R$ 40,00 da Beta (2u a R$ 20).
  await expect(page.getByText("+R$ 5,00", { exact: true }).first()).toBeVisible();

  await page.getByRole("tab", { name: "Segmentos" }).click();
  const matriz = page.getByRole("region", { name: "Matriz canal × mercado" });
  await expect(matriz).toContainText(`Alfa ${casa}`);
  await expect(matriz).toContainText(`Beta ${casa}`);
  await expect(page.getByText("Cortes sugeridos", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .exclude("[data-brand-wordmark]").analyze();
  expect(a11y.violations).toEqual([]);

  await matriz.getByRole("button", { name: new RegExp(`^Ver as 1 aposta de Beta`) }).click();
  const gaveta = page.getByRole("dialog");
  await expect(gaveta).toContainText("-R$ 40,00");
});

test("histórico denso mantém traçados e recortes proporcionais à tela", async ({ page, context, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "A mesma página confere desktop e mobile neste caso.");
  test.setTimeout(90_000);
  if (!new URL(process.env.DATABASE_URL ?? "").pathname.endsWith("_e2e")) throw new Error("Banco E2E obrigatório.");
  const slug = `analyzer-dense-${Date.now()}`;
  const bank = await prisma.bankroll.create({ data: { nome: "Histórico denso sintético", slug, sharpMode: "OFF" } });
  await prisma.$executeRaw`
    INSERT INTO bets (id, "bankrollId", data, evento, esporte, mercado, selecao, odds, stake,
      "sportResolvedAt", "updatedAt", status, lucro, "settledAt")
    SELECT gen_random_uuid()::text, ${bank.id}, now() - interval '1 day' + n*interval '1 second', 'Mandante vs Visitante',
      'Soccer', 'Moneyline', 'Mandante', 2, 1, now(), now(), 'WON'::"BetStatus", 1, now()
    FROM generate_series(1,25000) n`;
  await addAuthenticatedSession({ context, baseURL: baseURL! });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/tipsters/${slug}/analyzer`);
  await expect(page.getByRole("heading", { name: "Curva de lucro acumulado", exact: true })).toBeVisible();
  const pathBytes = await page.evaluate(() => [...document.querySelectorAll("svg path[d]")]
    .reduce((sum, path) => sum + (path.getAttribute("d")?.length ?? 0), 0));
  expect(pathBytes).toBeLessThan(1_000_000);
  await page.getByRole("button", { name: /^Ver as 25000 apostas sem CLV/ }).first().click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.locator('a[href^="/aposta"]')).toHaveCount(50);
  await expect(drawer).toContainText("Página 1 de 500");
  const firstId = await drawer.locator('a[href^="/aposta"]').first().getAttribute("href");
  await drawer.getByRole("button", { name: "Próxima", exact: true }).click();
  await expect(drawer).toContainText("Página 2 de 500");
  expect(await drawer.locator('a[href^="/aposta"]').first().getAttribute("href")).not.toBe(firstId);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(drawer.getByRole("button", { name: "Anterior", exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "Anterior", exact: true }).click();
  await expect(drawer).toContainText("Página 1 de 500");
  const a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .exclude("[data-brand-wordmark]").analyze();
  expect(a11y.violations).toEqual([]);
  await page.screenshot({ path: "artifacts/performance/analyzer-dense-mobile.png", fullPage: true });
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  expect(errors).toEqual([]);
});
