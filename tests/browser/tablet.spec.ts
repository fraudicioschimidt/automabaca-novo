import { coletarErrosDoNavegador, descreverErros } from "./helpers/console-errors";
import { expect, test } from "@playwright/test";
import { APP_COMPACT_BREAKPOINT } from "@/app/_design/layout";
import { addAuthenticatedSession } from "./helpers/authenticated-session";

test.beforeEach(async ({ context, baseURL }) => {
  await addAuthenticatedSession({ context, baseURL: baseURL! });
});

test("tablet mantém chrome compacto e conteúdo utilizável em 820px", async ({ page }) => {
  const errors = coletarErrosDoNavegador(page);
  const viewport = page.viewportSize();
  expect(viewport?.width).toBe(820);
  expect(viewport?.width).toBeGreaterThanOrEqual(768);
  expect(viewport?.width).toBeLessThanOrEqual(1023);
  expect(viewport!.width).toBeLessThan(APP_COMPACT_BREAKPOINT);

  const response = await page.goto("/", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await expect(
    page.locator(".app-mobile-header"),
    "tablet usa o header compacto, não a sidebar desktop",
  ).toBeVisible();
  await expect(page.locator(".app-sidebar-desktop")).toBeHidden();
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  );
  expect(overflow, "tablet não pode ter overflow horizontal").toBe(false);
  expect(errors, descreverErros(errors)).toEqual([]);
});
