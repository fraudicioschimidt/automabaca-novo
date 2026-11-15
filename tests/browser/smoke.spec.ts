import { coletarErrosDoNavegador, descreverErros } from "./helpers/console-errors";
import { expect, test } from "@playwright/test";
import { APP_COMPACT_BREAKPOINT } from "@/app/_design/layout";
import { NAV } from "@/app/_design/lib/atalhos";
import { addAuthenticatedSession } from "./helpers/authenticated-session";

const routes = ["/", "/tipsters", "/contas", "/ferramentas", "/operacoes", "/monitoramento", "/config"];

test.beforeEach(async ({ context, baseURL }) => {
  await addAuthenticatedSession({ context, baseURL: baseURL! });
});

test("SSR entrega chrome e conteúdo útil antes da hidratação", async ({ page }) => {
  const response = await page.goto("/", { waitUntil: "commit" });
  expect(response?.status()).toBe(200);
  const html = await response!.text();
  expect(html).toContain("app-shell");
  expect(html).toContain("Dashboard");
  expect(html).not.toMatch(/<div style="min-height:100vh[^>]*><\/div>/);
});

const ENDERECOS_ANTIGOS: ReadonlyArray<readonly [antigo: string, novo: string]> = [
  ["/entradas", "/tipsters"], ["/bankrolls", "/tipsters"], ["/bankrolls/treino?mock=1", "/tipsters/treino"],
];
for (const [antigo, novo] of ENDERECOS_ANTIGOS) {
  test(`o endereço antigo ${antigo} leva a ${novo}`, async ({ page }) => {
    const response = await page.goto(antigo, { waitUntil: "commit" });
    expect(response?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe(novo);
    expect(response?.request().redirectedFrom()).not.toBeNull();
  });
}

test("trajetória de odds mantém números e rótulos fora do SVG", async ({ page }) => {
  test.skip(process.env.VISUAL_TEST_MODE !== "1", "mock visual só existe no ambiente isolado");
  const response = await page.goto("/aposta?mock=1&id=b1", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  const chart = page.getByRole("img", { name: /Trajetória das odds/ });
  await expect(chart).toBeVisible();
  await expect(chart.getByText("Sua odd", { exact: true })).toBeVisible();
  await expect(chart.locator("svg text")).toHaveCount(0);
  await expect(chart.locator("[data-trajectory-value]").first()).toHaveCSS(
    "font-family",
    /Geist Mono/,
  );
  await expect(chart.locator("[data-trajectory-stage]").first()).toHaveCSS(
    "font-family",
    /Geist/,
  );
});

test("gráficos responsivos preservam a proporção da tipografia", async ({ page }) => {
  test.skip(process.env.VISUAL_TEST_MODE !== "1", "mock visual só existe no ambiente isolado");

  async function assertResponsiveCharts(): Promise<void> {
    const charts = page.locator("svg[data-responsive-chart='true']:visible").filter({ has: page.locator("text") });
    // Espera que REEXECUTA. `networkidle` não garante que o React pintou: o
    // gráfico nasce depois do mount-gate do DesignScreen, e `count()` é leitura
    // única: na máquina mais lenta, reprovaria com o SVG já presente no
    // snapshot do próprio erro.
    await expect(charts.first()).toBeVisible();
    const geometry = await charts.evaluateAll((nodes) => nodes.map((node) => {
      const svg = node as SVGSVGElement;
      const rect = svg.getBoundingClientRect();
      const viewBox = svg.viewBox.baseVal;
      return {
        label: svg.getAttribute("aria-label"),
        scaleX: rect.width / viewBox.width,
        scaleY: rect.height / viewBox.height,
      };
    }));
    for (const item of geometry) {
      expect(Math.abs(item.scaleX / item.scaleY - 1), `${item.label} não pode esticar texto no eixo horizontal`).toBeLessThan(0.03);
    }
  }

  for (const route of ["/?mock=1", "/tipsters/treino?mock=1", "/ferramentas?mock=1", "/tipsters/treino/analyzer?mock=1"]) {
    await page.goto(route, { waitUntil: "networkidle" });
    await assertResponsiveCharts();
  }

  // Espelha TABS de app/_design/screens/analyzer/icons.js — o clique num nome
  // inexistente vira timeout de 15s, não erro claro.
  for (const tab of ["CLV", "Abertura e linha", "Momento", "Liquidez", "Segmentos", "Casas", "Período"]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await page.waitForTimeout(50);
    const charts = page.locator("svg[data-responsive-chart='true']:visible");
    if (await charts.count()) await assertResponsiveCharts();
  }
});

test("Contas alterna para prestação por titular com subtotais", async ({ page }) => {
  test.skip(process.env.VISUAL_TEST_MODE !== "1", "mock visual só existe no ambiente isolado");
  await page.goto("/contas?mock=1", { waitUntil: "networkidle" });

  const ownerToggle = page.getByRole("button", { name: "Por titular", exact: true });
  await ownerToggle.click();
  await expect(ownerToggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(/Fabricio Schimidt\s*·\s*5/i)).toBeVisible();
  const subtotals = page.locator('[aria-label="Subtotais de Fabricio Schimidt"]');
  await expect(subtotals).toContainText("Saldo R$ 22.090,00");
  await expect(subtotals).toContainText("Depositado R$ 29.000,00");
  await expect(subtotals).toContainText("Sacado R$ 9.220,00");
});

test("Kelly oferece o CLV médio do canal como vantagem estimada", async ({ page }) => {
  test.skip(process.env.VISUAL_TEST_MODE !== "1", "mock visual só existe no ambiente isolado");
  await page.goto("/ferramentas?mock=1", { waitUntil: "networkidle" });

  // A tela é só a calculadora: não há backtest.
  await expect(page.getByText("Backtest")).toHaveCount(0);
  await expect(page.getByText("CLV médio de Ana Sharp:")).toBeVisible();
  await page.getByRole("button", { name: "usar como vantagem" }).click();
  await expect(page.getByLabel("Vantagem estimada")).toHaveValue("2.4");
});

test("paleta de comandos implementa navegação por teclado", async ({ page }) => {
  test.skip(process.env.VISUAL_TEST_MODE !== "1", "ambiente isolado obrigatório");
  await page.goto("/?mock=1", { waitUntil: "networkidle" });

  const dialog = page.getByRole("dialog", { name: "Busca e comandos" });
  // `networkidle` não prova que o React já ligou o listener de teclado, e a
  // paleta não renderiza NADA fechada (`if (!open) return null`) — não há
  // elemento para esperar. Então a tentativa é que reexecuta. O `isVisible`
  // antes da tecla é obrigatório: Ctrl+K ALTERNA, e insistir às cegas fecharia
  // a paleta que acabou de abrir.
  await expect(async () => {
    if (!(await dialog.isVisible())) await page.keyboard.press("Control+k");
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(dialog.getByRole("textbox", { name: "Buscar" })).toBeFocused();

  // A ordem é a da lista `NAV`, que a paleta desenha: destino novo no meio
  // dela não quebra o teste.
  const [first, second] = NAV;
  const focused = dialog.locator("[data-palette-action]:focus");
  await page.keyboard.press("ArrowDown");
  await expect(focused).toContainText(first.title);
  await page.keyboard.press("ArrowDown");
  await expect(focused).toContainText(second.title);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL((url) => url.pathname === second.href);
});

test("exclusão rápida permanece no menu de resultado", async ({ page }) => {
  test.skip(process.env.VISUAL_TEST_MODE !== "1", "mock visual só existe no ambiente isolado");
  await page.goto("/tipsters/treino?mock=1", { waitUntil: "networkidle" });

  await page.getByRole("button", { name: /Expandir detalhes de/ }).first().click();
  await expect(page.getByRole("link", { name: "Ver aposta completa", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Editar ou excluir", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: /Alterar resultado de/ }).first().click();
  const resultDialog = page.getByRole("dialog", { name: "Alterar resultado" });
  const pending = resultDialog.getByRole("button", { name: "Pendente", exact: true });
  const remove = resultDialog.getByRole("button", { name: "Excluir aposta", exact: true });
  await expect(pending).toBeVisible();
  await expect(remove).toBeVisible();
  const actions = await resultDialog.getByRole("button").allTextContents();
  expect(actions.slice(-2).map((label) => label.trim())).toEqual(["Pendente", "Excluir aposta"]);
  const menuBox = await resultDialog.boundingBox();
  const viewport = page.viewportSize();
  expect(menuBox && viewport && menuBox.y + menuBox.height <= viewport.height).toBe(true);

  await remove.click();
  const confirm = page.getByRole("alertdialog", { name: "Excluir aposta" });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Cancelar", exact: true })).toBeFocused();
  await expect(page).toHaveURL(/\/tipsters\/treino\?mock=1$/);
});

for (const route of routes) {
  test(`smoke ${route}`, async ({ page }) => {
    const errors = coletarErrosDoNavegador(page);

    const response = await page.goto(route, { waitUntil: "networkidle" });
    expect(response?.status(), `${route} deve responder HTTP 200`).toBe(200);
    // Sessão inválida redireciona ao /login — sem shell. Esperar o chrome real
    // em vez de `waitForTimeout(250)`: a corrida de época já foi fechada no
    // helper, e aqui a asserção precisa ser sobre o DOM autenticado.
    await expect(
      page.locator(".app-sidebar-desktop, .app-mobile-header").first(),
      `${route} deve renderizar o chrome do painel (não a tela de login)`,
    ).toBeAttached({ timeout: 15_000 });
    const nonce = response?.headers()["content-security-policy"]?.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce, `${route} precisa de nonce CSP`).toBeTruthy();
    // A largura do texto muda quando a fonte da web troca a de fallback, e o
    // `networkidle` não espera por isso. Sem esta linha a medição de overflow
    // amostra um layout intermediário e reprova páginas ao acaso, mesmo as que
    // não desenham gráfico nenhum.
    await page.evaluate(() => document.fonts.ready);
    const audit = await page.evaluate((expectedNonce) => {
      const desktopSidebar = document.querySelector<HTMLElement>(".app-sidebar-desktop");
      const mobileHeader = document.querySelector<HTMLElement>(".app-mobile-header");
      const main = document.querySelector<HTMLElement>(".app-main");
      const limite = document.documentElement.clientWidth;
      /**
       * QUEM estourou, não só QUE estourou. Sem o culpado nomeado, a próxima
       * ocorrência vira nova rodada de adivinhação — é a lição do
       * `falha-de-job-diagnosticavel` aplicada ao teste.
       */
      const culpados = [...document.querySelectorAll<HTMLElement>("body *")]
        .filter((el) => el.getBoundingClientRect().right > limite + 1)
        .slice(0, 5)
        .map((el) => {
          const r = el.getBoundingClientRect();
          const marca = el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "");
          return `${marca} right=${Math.round(r.right)} (limite ${limite})`;
        });
      return {
        culpados,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        unnamedButtons: [...document.querySelectorAll("button")].filter((element) =>
          !(element.textContent?.trim() || element.getAttribute("aria-label") || element.getAttribute("title")),
        ).length,
        empty: (document.body.textContent?.trim().length ?? 0) < 20,
        stylesWithoutNonce: [...document.querySelectorAll("style")]
          .filter((element) => element.nonce !== expectedNonce)
          .map((element) => element.textContent?.slice(0, 120) ?? ""),
        chrome: {
          viewportWidth: window.innerWidth,
          desktopSidebarDisplay: desktopSidebar ? getComputedStyle(desktopSidebar).display : null,
          mobileHeaderDisplay: mobileHeader ? getComputedStyle(mobileHeader).display : null,
          mainPaddingTop: main ? Number.parseFloat(getComputedStyle(main).paddingTop) : null,
        },
      };
    }, nonce);
    expect(
      audit.overflow,
      `${route} não pode ter overflow horizontal. Quem passou da borda: ${audit.culpados.join(" | ") || "nenhum elemento — provável barra de rolagem ou margem do documento"}`,
    ).toBe(false);
    expect(audit.unnamedButtons, `${route} não pode ter botões sem nome`).toBe(0);
    expect(audit.empty, `${route} não pode renderizar vazia`).toBe(false);
    expect(audit.stylesWithoutNonce, `${route} não pode criar <style> sem nonce`).toEqual([]);
    if (audit.chrome.viewportWidth < APP_COMPACT_BREAKPOINT) {
      expect(audit.chrome.desktopSidebarDisplay, `${route} deve ocultar sidebar no compacto`).toBe("none");
      expect(audit.chrome.mobileHeaderDisplay, `${route} deve mostrar header no compacto`).toBe("flex");
      expect(audit.chrome.mainPaddingTop, `${route} deve reservar o topo no compacto`).toBeGreaterThanOrEqual(84);
    } else {
      expect(audit.chrome.desktopSidebarDisplay, `${route} deve mostrar sidebar no desktop`).toBe("flex");
      expect(audit.chrome.mobileHeaderDisplay, `${route} deve ocultar header móvel no desktop`).toBe("none");
    }
    expect(errors, descreverErros(errors)).toEqual([]);
  });
}
