import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { APP_COMPACT_BREAKPOINT } from "@/app/_design/layout";
import { addAuthenticatedSession } from "./helpers/authenticated-session";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const routes = ["/login", "/", "/tipsters", "/contas", "/ferramentas", "/operacoes", "/monitoramento", "/config"];
const themes = ["light", "dark"] as const;

async function scan(page: Page, testInfo: TestInfo): Promise<void> {
  const wordmarks = page.locator("[data-brand-wordmark]");
  expect(await wordmarks.count()).toBeGreaterThan(0);
  const visibleWordmark = page.locator("[data-brand-wordmark]:visible").first();
  await expect(visibleWordmark).toHaveRole("img");
  await expect(visibleWordmark).toHaveAccessibleName("AutomaBACA");

  // WCAG 1.4.3 isenta texto que compõe logotipo/nome de marca. A exclusão é
  // deliberadamente limitada ao wordmark, cuja semântica é validada acima.
  const result = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .exclude("[data-brand-wordmark]")
    .analyze();
  await testInfo.attach("axe-wcag-report", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  expect(result.violations, result.violations.map((violation) =>
    `${violation.id}: ${violation.help} (${violation.nodes.length})`,
  ).join("\n")).toEqual([]);
}

test.beforeEach(async ({ context, baseURL }) => {
  await addAuthenticatedSession({ context, baseURL: baseURL! });
});

for (const theme of themes) {
  for (const route of routes) {
    test(`WCAG A/AA em ${theme} ${route}`, async ({ context, page, baseURL }, testInfo) => {
      await context.addCookies([{ name: "theme", value: theme, url: baseURL! }]);
      const response = await page.goto(route, { waitUntil: "networkidle" });
      expect(response?.status()).toBe(200);
      await scan(page, testInfo);
    });
  }

  test(`WCAG A/AA na ficha da aposta em ${theme}`, async ({ context, page, baseURL }, testInfo) => {
    test.skip(process.env.VISUAL_TEST_MODE !== "1", "mock visual só existe no ambiente isolado");
    await context.addCookies([{ name: "theme", value: theme, url: baseURL! }]);
    const response = await page.goto("/aposta?mock=1&id=b1", { waitUntil: "networkidle" });
    expect(response?.status()).toBe(200);
    await scan(page, testInfo);
  });

  // A pendente (b1) não tem o cartão da liquidação: a b11 cobre o contraste
  // dele e o refluxo das quatro colunas para duas, sem rolagem lateral.
  test(`WCAG A/AA na ficha de aposta liquidada em ${theme}`, async ({ context, page, baseURL }, testInfo) => {
    test.skip(process.env.VISUAL_TEST_MODE !== "1", "mock visual só existe no ambiente isolado");
    await context.addCookies([{ name: "theme", value: theme, url: baseURL! }]);
    const response = await page.goto("/aposta?mock=1&id=b11", { waitUntil: "networkidle" });
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Como foi liquidada" })).toBeVisible();
    const scrollsSideways = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(scrollsSideways, "a página não pode rolar para o lado").toBe(false);
    await scan(page, testInfo);
  });

  for (const [surface, route] of [
    ["detalhe da bankroll", "/tipsters/treino?mock=1"],
    ["Analyzer", "/tipsters/treino/analyzer?mock=1"],
  ] as const) {
    test(`WCAG A/AA em ${surface} no tema ${theme}`, async ({ context, page, baseURL }, testInfo) => {
      test.skip(process.env.VISUAL_TEST_MODE !== "1", "mock visual só existe no ambiente isolado");
      await context.addCookies([{ name: "theme", value: theme, url: baseURL! }]);
      const response = await page.goto(route, { waitUntil: "networkidle" });
      expect(response?.status()).toBe(200);
      await scan(page, testInfo);
    });
  }

  // A aba Simulador tem paleta própria para as curvas e a tabela mais larga do
  // Analyzer: varre o contraste e o refluxo (sem rolagem lateral da página).
  test(`WCAG A/AA no Simulador de stake da carteira em ${theme}`, async ({ context, page, baseURL }, testInfo) => {
    test.skip(process.env.VISUAL_TEST_MODE !== "1", "mock visual só existe no ambiente isolado");
    await context.addCookies([{ name: "theme", value: theme, url: baseURL! }]);
    await context.addInitScript(() => localStorage.setItem("automabaca:ui:analyzer:tab", JSON.stringify("simulador")));
    const response = await page.goto("/analyzer?mock=1", { waitUntil: "networkidle" });
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "E se a stake fosse outra?" })).toBeVisible();
    const scrollsSideways = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(scrollsSideways, "a página não pode rolar para o lado").toBe(false);
    await scan(page, testInfo);
  });
}

test("modal mantém foco, fecha por Escape e devolve foco ao acionador", async ({ page }, testInfo) => {
  await page.goto("/contas", { waitUntil: "networkidle" });
  const trigger = page.getByRole("button", { name: "Nova conta", exact: true });
  await trigger.focus();
  await trigger.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Nova conta" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(":focus")).toBeVisible();
  await scan(page, testInfo);

  const focusable = dialog.locator(
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  const count = await focusable.count();
  expect(count).toBeGreaterThan(1);
  const first = focusable.first();
  const last = focusable.last();
  await last.focus();
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  await first.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(last).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

for (const theme of themes) {
  test(`menu compacto preserva foco e encerra seu ciclo de vida em ${theme}`, async ({ context, page, baseURL }) => {
    const compactViewport = page.viewportSize();
    test.skip(!compactViewport || compactViewport.width >= APP_COMPACT_BREAKPOINT, "fluxo exclusivo do chrome compacto");
    await context.addCookies([{ name: "theme", value: theme, url: baseURL! }]);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.evaluate(() => { document.body.style.overflow = "clip"; });

    const trigger = page.getByRole("button", { name: "Abrir menu", includeHidden: true });
    await trigger.focus();
    await trigger.press("Enter");
    let dialog = page.getByRole("dialog", { name: "Menu principal" });
    await expect(dialog.getByRole("button", { name: "Fechar menu" })).toBeFocused();

    const currentThemeLabel = theme === "dark" ? "Usar tema claro" : "Usar tema escuro";
    const nextThemeLabel = theme === "dark" ? "Usar tema escuro" : "Usar tema claro";
    await dialog.getByRole("button", { name: currentThemeLabel }).focus();
    await dialog.getByRole("button", { name: currentThemeLabel }).press("Enter");
    await expect(dialog.getByRole("button", { name: nextThemeLabel })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Sair" })).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("clip");

    await trigger.press("Enter");
    dialog = page.getByRole("dialog", { name: "Menu principal" });
    await expect(dialog).toBeVisible();
    await page.setViewportSize({ width: APP_COMPACT_BREAKPOINT, height: 900 });
    await expect(dialog).toBeHidden();
    await expect(trigger).not.toBeFocused();
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("clip");

    await page.setViewportSize(compactViewport!);
    await expect(dialog).toBeHidden();
    await trigger.press("Enter");
    const reopenedDialog = page.getByRole("dialog", { name: "Menu principal" });
    await expect(reopenedDialog.getByRole("button", { name: "Fechar menu" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  });
}
