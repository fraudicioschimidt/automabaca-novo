import { expect, test, type Locator, type Page } from "@playwright/test";
import { addAuthenticatedSession } from "./helpers/authenticated-session";

/**
 * Geometria do cartão de KPI compartilhado pelas cinco abas do Analyzer, medida
 * no navegador (o smoke só abre a "Visão geral").
 */

type Aba = {
  chave: string;
  nome: string;
  primeiro: string;
  /** px do valor grande. */
  numero: number;
  /** px da linha de apoio sob o valor. */
  legenda: number;
  /** margem sob a linha do rótulo — 14 com ícone, 12 sem. */
  rotuloMargem: number;
  icone: boolean;
  /** cartões que ganham a régua "vs período anterior" (ver o teste no fim). */
  reguas: number;
  /** KPIs da aba; a grade larga tem uma coluna por cartão. */
  cartoes: number;
};

const ABAS: Aba[] = [
  { chave: "overview", nome: "Visão geral", primeiro: "Lucro total", numero: 30, legenda: 11.5, rotuloMargem: 14, icone: true, reguas: 3, cartoes: 3 },
  { chave: "clv", nome: "CLV", primeiro: "CLV médio", numero: 28, legenda: 11.5, rotuloMargem: 14, icone: true, reguas: 2, cartoes: 2 },
  { chave: "steam", nome: "Abertura e linha", primeiro: "Apostas com abertura", numero: 28, legenda: 11.5, rotuloMargem: 14, icone: true, reguas: 2, cartoes: 4 },
  { chave: "timing", nome: "Momento", primeiro: "Antecedência média", numero: 26, legenda: 11, rotuloMargem: 14, icone: true, reguas: 0, cartoes: 4 },
  { chave: "liquidez", nome: "Liquidez", primeiro: "Com liquidez no fechamento", numero: 26, legenda: 11, rotuloMargem: 12, icone: false, reguas: 0, cartoes: 4 },
];

const PERIODO_ANTERIOR = "os 7 dias anteriores";

test.beforeEach(async ({ context, baseURL, page }) => {
  test.skip(process.env.VISUAL_TEST_MODE !== "1", "mock visual só existe no ambiente isolado");
  await addAuthenticatedSession({ context, baseURL: baseURL! });
  await page.clock.setFixedTime(new Date("2026-07-12T15:00:00-03:00"));
});

/**
 * O Analyzer mantém conexões e tarefas em segundo plano; por isso
 * `networkidle` não representa que a interface terminou de abrir. O contrato
 * observável é a barra de abas pronta com a aba inicial selecionada.
 */
async function abrirAnalyzer(page: Page) {
  const resposta = await page.goto("/tipsters/treino/analyzer?mock=1", { waitUntil: "domcontentloaded" });
  expect(resposta?.ok(), "o Analyzer respondeu com sucesso").toBe(true);

  const abas = page.getByRole("tablist", { name: "Análises do tipster" });
  await expect(abas).toBeVisible();
  await expect(abas.getByRole("tab", { name: "Visão geral", exact: true })).toHaveAttribute("aria-selected", "true");
}

/**
 * A grade de KPIs da aba, ancorada em duas afirmações: ela É uma grade e o
 * primeiro cartão é o esperado. Medir o nó vizinho com número plausível é como
 * este teste viraria decoração.
 */
async function gradeDeKpis(page: Page, aba: Aba): Promise<Locator> {
  await page.getByRole("tab", { name: aba.nome, exact: true }).click();
  const grade = page.locator(`#analyzer-panel-${aba.chave} > div > div`).nth(1);
  await expect(grade, `${aba.nome}: a grade de KPIs não é o 2º bloco da aba`).toHaveCSS("display", "grid");
  await expect(grade.locator("> div")).toHaveCount(aba.cartoes);
  await expect(grade.locator("> div").first()).toContainText(aba.primeiro);
  return grade;
}

/**
 * Tudo o que se mede, numa leitura só. Sem funções auxiliares DENTRO do
 * `evaluate`: o transform do tsx renomeia função nomeada com `__name`, que não
 * existe no navegador e derruba a leitura antes de qualquer asserção.
 */
function medirGrade(grade: Locator) {
  return grade.evaluate((node) => {
    const grid = getComputedStyle(node);
    return {
      grade: {
        display: grid.display,
        colunas: grid.gridTemplateColumns.split(" ").length,
        rowGap: grid.rowGap,
        columnGap: grid.columnGap,
        marginBottom: grid.marginBottom,
      },
      cartoes: Array.from(node.children).map((cartao) => {
        const filhos = Array.from(cartao.children);
        const icone = cartao.querySelector("svg");
        const rotulo = getComputedStyle(filhos[0]!);
        // O rótulo com ícone é uma linha flex com o <div> do Cap dentro; sem
        // ícone, o próprio Cap é o primeiro filho.
        const cap = getComputedStyle(icone ? filhos[0]!.querySelector("div")! : filhos[0]!);
        const numero = getComputedStyle(filhos[1]!);
        const legenda = getComputedStyle(filhos[2]!);
        return {
          padding: getComputedStyle(cartao).padding,
          rotuloDisplay: rotulo.display,
          rotuloGap: rotulo.gap,
          rotuloMargem: rotulo.marginBottom,
          capCor: cap.color,
          iconeCor: icone ? getComputedStyle(icone).color : null,
          numeroFontSize: numero.fontSize,
          numeroFontWeight: numero.fontWeight,
          numeroFontFamily: numero.fontFamily,
          numeroLetterSpacing: numero.letterSpacing,
          numeroLineHeight: numero.lineHeight,
          numeroVariant: numero.fontVariantNumeric,
          numeroFeatures: numero.fontFeatureSettings,
          legendaFontSize: legenda.fontSize,
          legendaMarginTop: legenda.marginTop,
          legendaCor: legenda.color,
        };
      }),
    };
  });
}

test("o cartão de KPI tem a mesma geometria nas cinco abas do Analyzer", async ({ page }) => {
  await abrirAnalyzer(page);

  for (const aba of ABAS) {
    const grade = await gradeDeKpis(page, aba);
    const medida = await medirGrade(grade);
    const onde = (o: string) => `${aba.nome} · ${o}`;

    expect(medida.grade.colunas, onde("uma coluna por cartão")).toBe(aba.cartoes);
    expect(medida.grade.rowGap, onde("gap vertical")).toBe("16px");
    expect(medida.grade.columnGap, onde("gap horizontal")).toBe("16px");
    expect(medida.grade.marginBottom, onde("respiro sob a grade")).toBe("22px");

    for (const [i, cartao] of medida.cartoes.entries()) {
      const alvo = (o: string) => onde(`cartão ${i + 1} · ${o}`);
      expect(cartao.padding, alvo("padding")).toBe("20px");

      expect(cartao.rotuloMargem, alvo("margem sob o rótulo")).toBe(`${aba.rotuloMargem}px`);
      if (aba.icone) {
        expect(cartao.rotuloDisplay, alvo("linha do rótulo")).toBe("flex");
        expect(cartao.rotuloGap, alvo("gap entre ícone e rótulo")).toBe("8px");
        // O ícone desenha em currentColor: se a cor apagada não alcançar a
        // linha, ele herda o texto do cartão e fica preto sobre o cinza.
        expect(cartao.iconeCor, alvo("cor do ícone")).toBe(cartao.capCor);
      } else {
        expect(cartao.iconeCor, alvo("esta aba não tem ícone no KPI")).toBeNull();
      }

      expect(cartao.numeroFontSize, alvo("tamanho do número")).toBe(`${aba.numero}px`);
      expect(cartao.numeroFontWeight, alvo("peso do número")).toBe("600");
      expect(cartao.numeroFontFamily, alvo("família do número")).toContain("Geist Mono");
      expect(cartao.numeroLineHeight, alvo("lineHeight 1 do número")).toBe(`${aba.numero}px`);
      // -0.02em, que o navegador resolve contra o tamanho do próprio número.
      expect(parseFloat(cartao.numeroLetterSpacing), alvo("letterSpacing do número"))
        .toBeCloseTo(-0.02 * aba.numero, 2);
      expect(cartao.numeroVariant, alvo("tabular no número")).toBe("tabular-nums");
      // `"tnum" 1` declarado; o navegador normaliza o valor 1 fora do computado.
      expect(cartao.numeroFeatures, alvo("tnum no número")).toBe('"tnum"');

      expect(cartao.legendaFontSize, alvo("tamanho da legenda")).toBe(`${aba.legenda}px`);
      expect(cartao.legendaMarginTop, alvo("respiro sobre a legenda")).toBe("9px");
      expect(cartao.legendaCor, alvo("cor da legenda")).toBe(cartao.capCor);
    }
  }
});

test.describe("largura compacta", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("a grade de KPIs cai para duas colunas nas cinco abas", async ({ page }) => {
    await abrirAnalyzer(page);

    for (const aba of ABAS) {
      const grade = await gradeDeKpis(page, aba);
      const medida = await medirGrade(grade);
      expect(medida.grade.colunas, `${aba.nome}: colunas no frame compacto`).toBe(2);
      expect(medida.grade.columnGap, `${aba.nome}: gap no frame compacto`).toBe("16px");
    }
  });
});

test("a régua vs o período anterior aparece só onde a aba a pediu", async ({ page }) => {
  await abrirAnalyzer(page);
  // Sem janela anterior (`Tudo`) nenhuma régua existe — o recorte de 7 dias é o
  // que faz a comparação aparecer.
  await page.getByRole("button", { name: "Últimos 7 dias", exact: true }).click();

  for (const aba of ABAS) {
    const grade = await gradeDeKpis(page, aba);
    // "Abertura e linha" recusa a régua nos dois cartões de COBERTURA: comparar
    // "12 com abertura" contra "9" mede volume, não desempenho. "Momento" e
    // "Liquidez" não comparam nada. A contagem por cartão é o que prova a regra.
    const comRegua = await grade.evaluate(
      (node, rotulo) => Array.from(node.children).filter(
        (cartao) => Array.from(cartao.children).some((filho) => filho.textContent?.includes(rotulo)),
      ).length,
      PERIODO_ANTERIOR,
    );
    expect(comRegua, `${aba.nome}: cartões com régua vs o período anterior`).toBe(aba.reguas);
  }
});
