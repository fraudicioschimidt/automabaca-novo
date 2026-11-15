import { expect, test } from "@playwright/test";

test("login real rejeita senha incorreta e cria sessão com retorno à página pedida", async ({ page, context }) => {
  if (!process.env.AB_E2E_LOGIN_PASSWORD) throw new Error("Execute pelo runtime E2E isolado.");
  await context.clearCookies();
  await page.goto("/login?next=%2Fcontas");
  await page.getByLabel("Usuário", { exact: true }).fill("fabricio");
  await page.getByLabel("Senha", { exact: true }).fill("senha-incorreta-e2e");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.locator("#login-error")).toHaveText("Usuário ou senha inválidos.");
  await page.getByLabel("Senha", { exact: true }).fill(process.env.AB_E2E_LOGIN_PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page).toHaveURL(/\/contas$/);
  // A suíte roda o standalone de produção: o cookie leva o prefixo __Host-.
  const session = (await context.cookies()).find((cookie) => cookie.name === "__Host-automabaca_session");
  expect(session).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/", secure: true });
  await page.reload();
  await expect(page).toHaveURL(/\/contas$/);
});
