import { expect, test } from "@playwright/test";
import { prisma } from "@/src/infra/prisma";
import { addAuthenticatedSession } from "./helpers/authenticated-session";

/**
 * Metade VISUAL do portão do toast de erro (a de duração é pura e vive em
 * `tests/toast-janela-de-erro.test.ts`).
 *
 * O caso é o real, não um mock: depósito acima do teto financeiro. O servidor
 * recusa com `{ ok: false, erro: "Valor excede o limite financeiro da conta." }`
 * e a ÚNICA sinalização que o operador recebe é a pílula. Se ela some sozinha
 * com o modal ainda aberto e o valor no campo, quem piscar conclui que o clique
 * não fez nada e clica de novo.
 */

function requireIsolatedDatabase(): void {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL ausente no E2E");
  const database = new URL(raw).pathname.slice(1).split("?")[0] ?? "";
  if (!database.toLowerCase().includes("_e2e")) {
    throw new Error(`E2E recusado: banco "${database}" não contém _e2e`);
  }
}

test("recusa de depósito fica legível e só sai quando o operador dispensa", async ({ page, context, baseURL }) => {
  requireIsolatedDatabase();
  const marca = `toast-${Date.now()}`;
  const conta = await prisma.conta.create({
    data: { casaDeAposta: marca, titular: marca, saldoAtual: 100 },
  });

  await addAuthenticatedSession({ context, baseURL: baseURL! });
  const resposta = await page.goto("/contas", { waitUntil: "networkidle" });
  expect(resposta?.status()).toBe(200);

  // O cartão é o menor bloco que tem O NOME da conta E o botão de depósito —
  // `hasText` sozinho casa também com os ancestrais da página inteira.
  const cartao = page.locator("div")
    .filter({ hasText: marca })
    .filter({ has: page.getByText("Depósito", { exact: true }) })
    .last();
  await expect(cartao, "cartão da conta semeada não apareceu").toBeVisible();
  await cartao.getByText("Depósito", { exact: true }).first().click();
  const modal = page.getByRole("dialog");
  // Acima de MAX_ACCOUNT_BALANCE (9.999.999.999,99): recusa do serviço, não do form.
  await modal.locator("input").first().fill("99999999999");
  await page.getByRole("button", { name: /^dep[óo]sito$/i }).last().click();

  const aviso = page.getByRole("alert").filter({ hasText: "limite financeiro" });
  await expect(aviso, "a recusa precisa aparecer").toBeVisible();

  // Uma janela curta de toast (2,4s + fade) mais folga: o aviso ainda tem de estar aqui.
  await page.waitForTimeout(3200);
  await expect(aviso, "a recusa sumiu antes de o operador conseguir ler").toBeVisible();

  await aviso.getByRole("button", { name: "Dispensar aviso" }).click();
  await expect(aviso, "o × não dispensou o aviso").toBeHidden();

  // Fail-loud de verdade: recusou, então não moveu dinheiro.
  const saldo = await prisma.conta.findUniqueOrThrow({
    where: { id: conta.id },
    select: { saldoAtual: true },
  });
  expect(Number(saldo.saldoAtual)).toBe(100);
});
