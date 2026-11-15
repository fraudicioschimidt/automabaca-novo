import { coletarErrosDoNavegador, descreverErros } from "./helpers/console-errors";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { FOCUS_QUEUE_ACTION_DELAY_MS } from "@/app/_design/lib/atalhos";
import { spDayKey } from "@/src/domain/dates";
import { createBoss } from "@/src/infra/boss";
import { prisma } from "@/src/infra/prisma";
import { QUEUES } from "@/src/infra/queue-contract";
import { registerQueue } from "@/src/jobs/queues";
import { addAuthenticatedSession } from "./helpers/authenticated-session";

function requireIsolatedDatabase(): void {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL ausente no E2E");
  const database = new URL(raw).pathname.slice(1).split("?")[0] ?? "";
  if (!database.toLowerCase().includes("_e2e")) {
    throw new Error(`E2E recusado: banco "${database}" não contém _e2e`);
  }
}

async function clickAndWaitForDialogToClose(button: Locator, dialog: Locator): Promise<void> {
  await button.click();
  await expect(dialog).toBeHidden();
}

async function open(page: Page, path: string): Promise<void> {
  const response = await page.goto(path, { waitUntil: "networkidle" });
  expect(response?.status(), `${path} deve responder HTTP 200`).toBe(200);
}

/** O histórico só abre o mês mais recente; tip seed no mês seguinte esconde o do dia. */
async function openResultMenu(page: Page, home: string, away: string): Promise<void> {
  const resultButton = page.getByRole("button", {
    name: `Alterar resultado de ${home} contra ${away}`,
  });
  if (!(await resultButton.isVisible().catch(() => false))) {
    for (const toggle of await page.getByRole("button", { name: /\d+ aposta/ }).all()) {
      if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
    }
  }
  await resultButton.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await resultButton.click();
}

test.beforeAll(async () => {
  requireIsolatedDatabase();
  const setupBoss = createBoss();
  await setupBoss.start();
  try {
    await registerQueue(setupBoss, QUEUES.sharpEnrich);
  } finally {
    await setupBoss.stop({ graceful: true });
  }
});

test("fluxos críticos persistem de ponta a ponta", async ({ context, page, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const suffix = `${Date.now()}-${testInfo.retry}`;
  const slug = `e2e-critical-${suffix}`;
  const home = `E2E Home ${suffix}`;
  const away = `E2E Away ${suffix}`;
  const accountName = `E2E Book ${suffix}`;
  const tipsterTeamName = `E2E Tipster Time ${suffix}`;
  const sharpHome = `E2E Sharp ${suffix}`;
  const deletionBankrollName = `E2E Excluir ${suffix}`;

  const bankroll = await prisma.bankroll.create({
    data: {
      nome: `E2E Critical ${suffix}`,
      slug,
      capitalInicial: 1_000,
      valorUnidade: 25,
      sharpMode: "OFF",
    },
  });
  const deletionBankroll = await prisma.bankroll.create({
    data: {
      nome: deletionBankrollName,
      slug: `e2e-delete-${suffix}`,
      valorUnidade: 25,
      sharpMode: "OFF",
    },
  });
  const deletionBet = await prisma.bet.create({
    data: {
      bankrollId: deletionBankroll.id,
      data: new Date("2026-08-20T18:00:00Z"),
      evento: `Excluir Home ${suffix} vs Excluir Away ${suffix}`,
      esporte: "Soccer",
      mercado: "Moneyline",
      selecao: `Excluir Home ${suffix}`,
      odds: 2,
      stake: 1,
      valorUnidade: 25,
      sportResolvedAt: new Date(),
      source: "e2e-critical-delete",
      sourceExternalId: suffix,
    },
  });
  // Ficha de time com um nome de tipster, como o pareamento e a identidade gravam.
  const teamCard = await prisma.teamCard.create({
    data: {
      sport: "Soccer", flashscoreTeamId: `e2e-${suffix}`, flashscoreName: `E2E FS ${suffix}`, country: "Brazil",
      category: "principal", lastSeenAt: new Date(),
      evidence: { create: { pinnacleEventId: `e2e-${suffix}`, pinnacleName: `E2E Pinnacle ${suffix}`, nameNorm: `e2e pinnacle ${suffix}`,
        category: "principal", leagueKey: "brazil|e2e league" } },
    },
  });
  const tipsterName = await prisma.teamTipsterName.create({
    data: { cardId: teamCard.id, sport: "Soccer", name: tipsterTeamName, nameNorm: tipsterTeamName.toLowerCase(),
      firstBetId: `e2e-${suffix}`, firstDay: "2026-09-24", category: "principal", firstPinnacleEventId: `e2e-${suffix}` },
  });
  // Mesmo mês civil do tip criado pela UI: +1 dia na virada (31→01) faz o
  // histórico expandir só o mês seguinte e esconde o botão "Alterar resultado".
  const sharpKickoff = new Date(Date.now() + 2 * 3_600_000);
  const sharpBet = await prisma.bet.create({
    data: {
      bankrollId: bankroll.id,
      data: sharpKickoff,
      evento: `${sharpHome} vs E2E Pending`,
      esporte: "Soccer",
      // Fixture é um writer direto: CONFIRMED precisa declarar quando resolveu,
      // igual ao registerBet de produção (CHECK bets_sport_resolved_at_consistency).
      sportResolvedAt: new Date(),
      mercado: "Total",
      selecao: "Under 2.5",
      odds: 1.9,
      stake: 1,
      valorUnidade: 25,
      source: "e2e-seed",
    },
  });
  await prisma.betSharp.create({ data: { betId: sharpBet.id, identityStatus: "PENDING" } });

  await addAuthenticatedSession({
    context,
    baseURL: baseURL!,
  });

  const browserErrors = coletarErrosDoNavegador(page);
  page.on("response", (response) => {
    if (response.status() >= 500) {
      browserErrors.push({ origem: response.url(), texto: `HTTP ${response.status()}` });
    }
  });

  await open(page, `/tipsters/${slug}`);
  await page.getByRole("button", { name: "Adicionar aposta", exact: true }).first().click();
  const addDialog = page.getByRole("dialog", { name: "Adicionar aposta" });
  await addDialog.locator('input[name="home"]').fill(home);
  await addDialog.locator('input[name="away"]').fill(away);
  await addDialog.locator('select[name="esporte"]').selectOption("Basketball");
  await addDialog.locator('input[name="region"]').fill("BR");
  await addDialog.locator('input[name="competition"]').fill("E2E League");
  await addDialog.locator('input[name="line"]').fill("Over 150.5");
  await addDialog.locator('input[name="odds"]').fill("2.10");
  await addDialog.locator('input[name="stake"]').fill("1.25");
  await addDialog.locator('input[name="date"]').fill(spDayKey(new Date()));
  // O fluxo liquida em seguida e também verifica a célula "hoje" do calendário.
  // Meia-noite de hoje em SP já passou; 18:30 deixaria o evento no futuro de manhã.
  await addDialog.locator('input[name="time"]').fill("00:00");
  await addDialog.locator('input[name="casa"]').fill(accountName);
  await expect(addDialog.getByRole("button", { name: "Adicionar aposta", exact: true }))
    .toHaveCSS("font-family", /Geist/);
  await clickAndWaitForDialogToClose(
    addDialog.getByRole("button", { name: "Adicionar aposta", exact: true }),
    addDialog,
  );
  await expect.poll(() => prisma.bet.count({
    where: { bankrollId: bankroll.id, evento: `${home} vs ${away}` },
  })).toBe(1);
  const createdBet = await prisma.bet.findFirstOrThrow({
    where: { bankrollId: bankroll.id, evento: `${home} vs ${away}` },
  });
  expect(`${createdBet.esporte}:${createdBet.pais}:${createdBet.competicao}`)
    .toBe("Basketball:Brazil:E2E League");

  await page.getByRole("button", { name: "Calendário", exact: true }).click();
  const calendar = page.getByRole("dialog", { name: "Calendário" });
  const todayCell = calendar.getByText("hoje", { exact: true }).locator("xpath=ancestor::button[1]");
  await expect(todayCell).toBeVisible();
  await expect(todayCell).toHaveCSS("font-family", /Geist/);
  await expect(calendar.getByRole("region", { name: "Apostas do dia" }).getByText(home, { exact: false }))
    .toBeVisible();
  await calendar.getByRole("button", { name: "Fechar" }).click();

  await page.getByRole("button", { name: "Compartilhar", exact: true }).click();
  const shareDialog = page.getByRole("dialog", { name: "Compartilhar desempenho" });
  await expect(shareDialog.getByRole("button", { name: "Copiar resumo", exact: true }))
    .toHaveCSS("font-family", /Geist/);
  await expect(shareDialog.getByRole("button", { name: "Fechar" })).toHaveCSS("font-size", "19px");
  await shareDialog.getByRole("button", { name: "Fechar" }).click();

  await openResultMenu(page, home, away);
  await expect(page.getByText("Alterar resultado", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Ganha", exact: true }).click();
  await expect.poll(async () => {
    const bet = await prisma.bet.findUnique({ where: { id: createdBet.id } });
    return bet?.status === "WON" && Number(bet.lucro) > 0;
  }).toBe(true);

  await open(page, `/aposta?id=${createdBet.id}`);
  await page.getByRole("button", { name: "Editar", exact: true }).click();
  const editBetDialog = page.getByRole("dialog", { name: "Editar aposta" });
  await editBetDialog.getByLabel("Mandante").fill(`${home} Editado`);
  await editBetDialog.getByLabel("Odd").fill("2.25");
  await clickAndWaitForDialogToClose(
    editBetDialog.getByRole("button", { name: "Salvar alterações", exact: true }),
    editBetDialog,
  );
  await expect.poll(async () => {
    const bet = await prisma.bet.findUnique({ where: { id: createdBet.id } });
    return bet
      ? `${bet.status}:${Number(bet.odds).toFixed(2)}:${bet.evento}`
      : null;
  }).toBe(`PENDING:2.25:${home} Editado vs ${away}`);

  await open(page, `/tipsters/${slug}`);
  await openResultMenu(page, `${home} Editado`, away);
  const resultDialog = page.getByRole("dialog", { name: "Alterar resultado" });
  await expect(resultDialog).toBeVisible();
  await resultDialog.getByRole("button", { name: "Excluir aposta", exact: true }).click();
  const deleteBetDialog = page.getByRole("alertdialog", { name: "Excluir aposta" });
  await expect(deleteBetDialog.getByText(`${home} Editado vs ${away}`, { exact: true })).toBeVisible();
  await deleteBetDialog.getByRole("button", { name: "Excluir aposta", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/tipsters/${slug}$`));
  await expect.poll(async () =>
    (await prisma.bet.findUnique({ where: { id: createdBet.id } }))?.deletedAt != null,
  ).toBe(true);
  await expect(page.getByText(`${home} Editado`, { exact: false })).toHaveCount(0);

  await open(page, "/contas");
  await page.getByRole("button", { name: "Nova conta", exact: true }).click();
  const accountDialog = page.getByRole("dialog", { name: "Nova conta" });
  const accountInputs = accountDialog.locator("input");
  await accountInputs.nth(0).fill(accountName);
  await accountInputs.nth(1).fill(`Titular ${suffix}`);
  await accountInputs.nth(2).fill("Principal E2E");
  await accountInputs.nth(3).fill("100");
  await clickAndWaitForDialogToClose(
    accountDialog.getByRole("button", { name: "Criar conta", exact: true }),
    accountDialog,
  );
  await expect.poll(() => prisma.conta.count({
    where: { casaDeAposta: accountName, deletedAt: null },
  })).toBe(1);
  const account = await prisma.conta.findFirstOrThrow({
    where: { casaDeAposta: accountName, deletedAt: null },
  });
  const accountCard = page.getByText(accountName, { exact: true })
    .locator("xpath=ancestor::div[.//button[normalize-space(.)='Depósito']][1]");
  await accountCard.getByRole("button", { name: "Depósito", exact: true }).click();
  const depositDialog = page.getByRole("dialog", { name: `Depósito · ${accountName}` });
  await depositDialog.locator("input").nth(0).fill("50");
  await depositDialog.locator("input").nth(1).fill("Depósito E2E");
  await clickAndWaitForDialogToClose(
    depositDialog.getByRole("button", { name: "Depósito", exact: true }),
    depositDialog,
  );
  await expect.poll(async () => {
    const current = await prisma.conta.findUnique({ where: { id: account.id } });
    return current ? Number(current.saldoAtual) : null;
  }).toBe(150);

  // Conta vinculada: liquidação credita em R$ pelo snapshot da unidade;
  // editar reabre a aposta e estorna exatamente o lançamento anterior.
  const ledgerHome = `Ledger Home ${suffix}`;
  const ledgerAway = `Ledger Away ${suffix}`;
  const linkedBet = await prisma.bet.create({ data: {
    bankrollId: bankroll.id, contaId: account.id, casaDeAposta: accountName,
    data: new Date(`${spDayKey(new Date())}T00:00:00-03:00`),
    evento: `${ledgerHome} vs ${ledgerAway}`, esporte: "Soccer", sportResolvedAt: new Date(),
    mercado: "Moneyline", selecao: ledgerHome, odds: 2, stake: 1, valorUnidade: 25,
    source: "e2e-linked-account",
  } });
  await open(page, `/tipsters/${slug}`);
  await openResultMenu(page, ledgerHome, ledgerAway);
  await page.getByRole("button", { name: "Ganha", exact: true }).click();
  await expect.poll(async () => Number((await prisma.conta.findUniqueOrThrow({ where: { id: account.id } })).saldoAtual)).toBe(175);
  await open(page, `/aposta?id=${linkedBet.id}`);
  await page.getByRole("button", { name: "Editar", exact: true }).click();
  const reopenDialog = page.getByRole("dialog", { name: "Editar aposta" });
  await reopenDialog.getByLabel("Odd", { exact: true }).fill("2.10");
  await clickAndWaitForDialogToClose(reopenDialog.getByRole("button", { name: "Salvar alterações" }), reopenDialog);
  await expect.poll(async () => (await prisma.bet.findUniqueOrThrow({ where: { id: linkedBet.id } })).status).toBe("PENDING");
  await expect.poll(async () => Number((await prisma.conta.findUniqueOrThrow({ where: { id: account.id } })).saldoAtual)).toBe(150);
  const ledgerTotal = await prisma.movimentacao.aggregate({ where: { contaId: account.id }, _sum: { valor: true } });
  expect(Number(ledgerTotal._sum.valor)).toBe(150);
  await open(page, "/contas");
  await accountCard.getByRole("link", { name: "Ver detalhes", exact: false }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Editar", exact: true }).click();
  const editDialog = page.getByRole("dialog", { name: "Editar conta" });
  // Casa/titular ficam imutáveis depois do primeiro movimento (e75e64a).
  // Apelido continua mutável e ainda exercita conta.update.
  await editDialog.locator("input").nth(2).fill(`Apelido editado ${suffix}`);
  await clickAndWaitForDialogToClose(
    editDialog.getByRole("button", { name: "Salvar", exact: true }),
    editDialog,
  );
  await expect.poll(async () =>
    (await prisma.conta.findUnique({ where: { id: account.id } }))?.apelido,
  ).toBe(`Apelido editado ${suffix}`);

  // RECUSA VISÍVEL: ainda na ficha da conta, que tem R$ 150 de saldo.
  //
  // Server action que LANÇA perde a mensagem ("An error occurred in the Server
  // Components render…"), e o operador fica sem saber o que fazer. A recusa
  // tem de chegar à tela com o motivo.
  await page.getByRole("button", { name: "Excluir", exact: true }).click();
  const dialogExcluir = page.getByRole("dialog", { name: "Excluir conta" });
  await expect(dialogExcluir).toBeVisible();
  await dialogExcluir.getByRole("button", { name: "Excluir", exact: true }).click();
  await expect(page.getByText(/zere o saldo da conta antes de rem/i)).toBeVisible();
  // O overlay CONTINUA aberto: fechar esconderia o motivo junto com o problema.
  await expect(dialogExcluir).toBeVisible();
  // E a conta continua viva — recusa não é meio-caminho.
  expect(await prisma.conta.count({ where: { id: account.id, deletedAt: null } })).toBe(1);
  await page.keyboard.press("Escape");

  await open(page, "/config");
  await page.getByRole("button", {
    name: `Excluir ${deletionBankrollName} permanentemente`,
  }).click();
  const deleteBankrollDialog = page.getByRole("dialog", {
    name: "Excluir tipster permanentemente",
  });
  await expect(deleteBankrollDialog).toContainText("sua 1 aposta");
  await expect(deleteBankrollDialog).toContainText("efeitos financeiros");
  await expect(deleteBankrollDialog).toContainText("não pode ser desfeita");
  await clickAndWaitForDialogToClose(
    deleteBankrollDialog.getByRole("button", { name: "Excluir definitivamente" }),
    deleteBankrollDialog,
  );
  await expect.poll(() => prisma.bankroll.count({ where: { id: deletionBankroll.id } })).toBe(0);
  await expect.poll(() => prisma.bet.count({ where: { id: deletionBet.id } })).toBe(0);

  // Config é dividido em seções: a lista de times enterraria o resto. A busca
  // acha a ficha pelo nome do tipster, e remover o nome pede confirmação.
  await page.getByRole("tab", { name: /^Times/ }).click();
  await page.getByRole("searchbox", { name: "Buscar time por qualquer nome" }).fill(tipsterTeamName);
  await expect(page.getByRole("list", { name: "Times" }).getByRole("listitem")).toHaveCount(1);
  await page.getByRole("button", { name: `Remover o nome de tipster ${tipsterTeamName}`, exact: true }).click();
  const removeNameDialog = page.getByRole("dialog", { name: "Remover nome de tipster" });
  await expect(removeNameDialog).toContainText(`${tipsterTeamName} → E2E Pinnacle ${suffix}`);
  await clickAndWaitForDialogToClose(
    removeNameDialog.getByRole("button", { name: "Remover nome", exact: true }),
    removeNameDialog,
  );
  await expect.poll(() => prisma.teamTipsterName.count({ where: { id: tipsterName.id } })).toBe(0);
  await expect.poll(() => prisma.auditEvent.count({
    where: { action: "team_tipster_name.delete", resourceId: tipsterName.id },
  })).toBe(1);

  await open(page, "/operacoes");
  await expect(page.getByRole("heading", { name: "Caixa de ações", exact: true })).toHaveCount(0);
  // As filas são seções, uma por vez. A fila aberta é a primeira COM backlog,
  // então o teste escolhe a sua explicitamente.
  await page.getByRole("tab", { name: /^Sharp/ }).click();
  // A fila mostra um caso por vez, e a tentativa anterior do teste pode ter
  // deixado outra aposta sem par antes desta: avança até o caso dela.
  const sharpQueue = page.getByRole("tabpanel");
  const sharpCase = sharpQueue.getByRole("heading", { name: new RegExp(sharpHome) });
  await expect(sharpQueue.getByRole("heading").first()).toBeVisible();
  for (let i = 0; i < 20 && !(await sharpCase.isVisible()); i++) {
    await sharpQueue.getByRole("button", { name: /próximo/ }).click();
  }
  await expect(sharpCase).toBeVisible();
  // O caso recém-posto em foco ainda não aceita ação.
  await page.waitForTimeout(FOCUS_QUEUE_ACTION_DELAY_MS);
  await sharpQueue.getByRole("button", { name: /^Reprocessar agora/ }).click();
  await expect.poll(() => prisma.auditEvent.count({
    where: { action: "sharp.reprocess", resourceId: sharpBet.id },
  })).toBe(1);
  await open(page, "/monitoramento");
  await expect(page.getByRole("heading", { name: "Caixa de ações", exact: true })).toBeVisible();
  // Monitoramento também é dividido em seções: o SLO tem aba própria, então o
  // teste navega até ela em vez de assumir tudo na tela.
  await page.getByRole("tab", { name: /^Desempenho/ }).click();
  await expect(page.getByText("SLO operacional", { exact: true })).toBeVisible();

  const actionNames = await prisma.operationalMetric.findMany({
    where: { kind: "action" },
    select: { name: true },
  });
  const observed = new Set(actionNames.map((metric) => metric.name));
  for (const expected of [
    "bet.register", "bet.settle", "bet.edit", "bet.delete", "conta.create", "conta.movement",
    "conta.update", "team_tipster_name.delete", "sharp.reprocess",
  ]) {
    expect(observed, `métrica de ação ausente: ${expected}`).toContain(expected);
  }
  expect(browserErrors, descreverErros(browserErrors)).toEqual([]);
});
