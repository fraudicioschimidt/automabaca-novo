import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

/**
 * Server actions de Config contra Postgres real, borda Next mockada. Cobre a
 * autorização (requireSession) do lado Config e a validação do input de
 * criarBankroll (unidade não-numérica não pode virar 0u calado).
 */
const h = vi.hoisted(() => ({ user: "tester" }));
vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (k: string) => (k === "x-auth-user" ? h.user : null),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const boss = vi.hoisted(() => ({ send: vi.fn(async () => "job"), cancel: vi.fn(async () => undefined) }));
vi.mock("@/src/infra/boss", () => ({ getSharedBoss: async () => boss }));

import { createTestDb, type TestDb } from "../helpers/db";
import {
  createBankrollAction as createBankrollActionReal,
  editarBankrollAction,
  loadTeamCardsAction,
  removeTipsterNameAction,
  removeLogoAction,
  uploadLogoAction,
  excluirBankrollAction,
  addMarketAliasAction,
  removeMarketAliasAction,
} from "@/app/(painel)/config/actions";
import { getConfigPageData } from "@/src/services/painel/config";
import { toNumber } from "@/src/domain/money";
import { editarBankroll } from "@/src/services/bankrolls/manage";

function createBankrollAction(input: Omit<Parameters<typeof createBankrollActionReal>[0], "requestId"> & { requestId?: string }) {
  return createBankrollActionReal({ ...input, requestId: input.requestId ?? randomUUID() });
}

it("criação de tipster exige identificador e o reenvio retorna o mesmo recurso", async () => {
  const input = { name: "Reenvio", unit: "100", channel: "" };
  expect(await createBankrollActionReal(input as Parameters<typeof createBankrollActionReal>[0])).toMatchObject({ ok: false });
  expect(await db.prisma.bankroll.count()).toBe(0);
  const request = { ...input, requestId: randomUUID() };
  const first = await createBankrollActionReal(request);
  expect(first).toMatchObject({ ok: true });
  expect(await createBankrollActionReal(request)).toEqual(first);
  expect(await db.prisma.bankroll.count()).toBe(1);
});

/** A mensagem da recusa que a action devolve; falha se ela não recusou. */
async function recusa(result: Promise<{ ok: boolean; erro?: string }>): Promise<string> {
  const r = await result;
  if (r.ok) throw new Error("a action deveria ter recusado");
  return r.erro ?? "";
}

let db: TestDb;
const originalLogosDir = process.env.LOGOS_DIR;
beforeAll(() => {
  process.env.LOGOS_DIR = path.resolve(".test-logos-actions-config");
  db = createTestDb();
});
afterAll(async () => {
  await db.dispose();
  if (originalLogosDir === undefined) delete process.env.LOGOS_DIR;
  else process.env.LOGOS_DIR = originalLogosDir;
});
beforeEach(async () => {
  await db.reset();
  h.user = "tester";
});

describe("unidade monetária na Config", () => {
  it("um agrupamento malformado não cria tipster com outro valor da unidade", async () => {
    const result = await createBankrollAction({ name: "Entrada inválida", unit: "1 2", channel: "" });
    expect(result.ok).toBe(false);
    expect(await db.prisma.bankroll.count()).toBe(0);
  });

  it("a edição com número quebrado não altera a unidade gravada", async () => {
    const bank = await db.prisma.bankroll.create({ data: { nome: "Unidade preservada", slug: "unidade-preservada", valorUnidade: 100 } });
    const result = await editarBankrollAction({ id: bank.id, name: bank.nome, unit: "1,\n50", channel: "", sharpMode: "CLV_ONLY", capturePolicy: "AUTO" });
    expect(result.ok).toBe(false);
    expect(toNumber((await db.prisma.bankroll.findUniqueOrThrow({ where: { id: bank.id } })).valorUnidade)).toBe(100);
  });
});

describe("esportes do canal trocados reavaliam as apostas ainda sem esporte", () => {
  it("põe na fila do resolvedor só as pendentes do canal, e só quando a marcação muda", async () => {
    const bk = await db.prisma.bankroll.create({ data: { nome: "Big Data", slug: "big-data", valorUnidade: 100 } });
    const bet = (sportResolutionStatus: "PENDING" | "CONFIRMED" | "CONFLICT", n: number) => db.prisma.bet.create({ data: {
      bankrollId: bk.id, data: new Date("2026-09-25T20:00:00Z"), evento: `Time ${n} vs Rival`, esporte: sportResolutionStatus === "CONFIRMED" ? "Soccer" : "Unknown",
      mercado: "Moneyline", selecao: `Time ${n}`, odds: 1.9, stake: 1, sportResolutionStatus,
      ...(sportResolutionStatus === "CONFIRMED" ? { sportResolvedAt: new Date() } : {}),
    } });
    const pending = await bet("PENDING", 1);
    await bet("CONFIRMED", 2);
    await bet("CONFLICT", 3);
    const fields = { id: bk.id, name: "Big Data", unit: "100", channel: "", sharpMode: "CLV_ONLY" as const, capturePolicy: "AUTO" as const };
    boss.send.mockClear();

    await editarBankrollAction({ ...fields, channelSports: ["Soccer"] });
    expect(boss.send).toHaveBeenCalledTimes(1);
    // Tentativa avulsa: a cadeia de backoff da aposta não é cancelada nem reiniciada.
    expect(boss.send).toHaveBeenCalledWith("capture.sport_resolve",
      expect.objectContaining({ betId: pending.id, origem: "channel_sports_changed", oneShot: true }),
      expect.objectContaining({ singletonKey: expect.stringMatching(/:one-shot$/) }));
    expect(boss.cancel).not.toHaveBeenCalled();

    // Salvar de novo a mesma marcação não recomeça a busca.
    await editarBankrollAction({ ...fields, channelSports: ["Soccer"] });
    expect(boss.send).toHaveBeenCalledTimes(1);
  });
});

describe("createBankrollAction (Postgres real + borda mockada)", () => {
  it.each([119, 120])("homônimos com nome de %s caracteres conservam um endereço aceito pelo painel", async (length) => {
    const name = "x".repeat(length);
    const first = await createBankrollAction({ name, unit: "100", channel: "" });
    const second = await createBankrollAction({ name, unit: "100", channel: "" });
    if (!first.ok || !second.ok) throw new Error("Falha na criação dos homônimos");
    expect(first.id).not.toBe(second.id);
    expect(first.slug).not.toBe(second.slug);
    expect(second.slug.length).toBeLessThanOrEqual(120);
    const slugs = new Set([first.slug, second.slug]);
    for (let index = 3; index <= 10; index++) {
      const next = await createBankrollAction({ name, unit: "100", channel: "" });
      if (!next.ok) throw new Error("Falha na criação de homônimo adicional");
      expect(next.slug.length).toBeLessThanOrEqual(120);
      expect(next.slug).toMatch(new RegExp(`-${index}$`));
      slugs.add(next.slug);
    }
    expect(slugs.size).toBe(10);
    await expect(removeLogoAction(second.slug)).resolves.toMatchObject({ ok: true });
    await editarBankroll(second.id, { nome: "Renomeado" }, "tester");
    expect((await db.prisma.bankroll.findUniqueOrThrow({ where: { id: second.id } })).slug).toBe(second.slug);
  });

  it("duas criações simultâneas para o mesmo canal resultam em um cadastro e uma recusa", async () => {
    const outcomes = await Promise.all([
      createBankrollAction({ name: "Primeiro", unit: "100", channel: "-100987654321" }),
      createBankrollAction({ name: "Segundo", unit: "100", channel: "-100987654321" }),
    ]);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.find((outcome) => !outcome.ok)).toMatchObject({ ok: false, erro: expect.stringContaining("Canal já mapeado") });
    expect(await db.prisma.bankroll.count()).toBe(1);
  });

  it("configura stake padrão por banca com validação e auditoria", async () => {
    const bk = await db.prisma.bankroll.create({ data: { nome: "Stake", slug: "stake", valorUnidade: 100 } });
    const fields = { id: bk.id, name: "Stake", unit: "100", channel: "", sharpMode: "CLV_ONLY" as const, capturePolicy: "AUTO" as const };
    await editarBankrollAction({ ...fields, stakePolicy: "WHEN_MISSING", defaultStakeUnits: "1,25" });
    const saved = await db.prisma.bankroll.findUniqueOrThrow({ where: { id: bk.id } });
    expect(saved.stakePolicy).toBe("WHEN_MISSING");
    expect(Number(saved.defaultStakeUnits)).toBe(1.25);
    const config = await getConfigPageData();
    expect(config.bankrolls[0]).toMatchObject({ stakePolicy: "WHEN_MISSING", defaultStakeUnits: 1.25 });
    await editarBankroll(bk.id, { nome: "Stake renomeada" });
    expect((await db.prisma.bankroll.findUniqueOrThrow({ where: { id: bk.id } })).stakePolicy).toBe("WHEN_MISSING");
    expect(await recusa(editarBankrollAction({ ...fields, stakePolicy: "ALWAYS", defaultStakeUnits: "0" }))).toMatch(/stake/i);
    expect(await recusa(editarBankrollAction({ ...fields, stakePolicy: "ALWAYS", defaultStakeUnits: null }))).toMatch(/stake/i);
    await editarBankrollAction({ ...fields, stakePolicy: "MESSAGE", defaultStakeUnits: null });
    expect((await db.prisma.bankroll.findUniqueOrThrow({ where: { id: bk.id } })).defaultStakeUnits).toBeNull();
  });
  it("admin cria banca com capital 100u e a unidade informada", async () => {
    const created = await createBankrollAction({ name: "Nova Banca", unit: "50", channel: "" });
    if (!created.ok) throw new Error(created.erro);
    const bk = await db.prisma.bankroll.findFirstOrThrow({ where: { nome: "Nova Banca" } });
    // retorna o id/slug reais (a tela troca o id otimista pelo real p/ editar/remover já funcionar)
    expect(created.id).toBe(bk.id);
    expect(created.slug).toBe(bk.slug);
    expect(toNumber(bk.valorUnidade)).toBe(50);
    expect(toNumber(bk.capitalInicial)).toBe(100);
    expect(bk.sharpMode).toBe("CLV_ONLY");
    expect(await db.prisma.auditEvent.count({
      where: { action: "bankroll.create", actor: "tester", resourceId: bk.id },
    })).toBe(1);
  });

  it("aceita unidade com separador decimal brasileiro", async () => {
    await createBankrollAction({ name: "Banca BR", unit: "20,5", channel: "" });
    const bk = await db.prisma.bankroll.findFirstOrThrow({ where: { nome: "Banca BR" } });
    expect(toNumber(bk.valorUnidade)).toBe(20.5);
  });

  it("sem sessão é BARRADO (regressão de autorização)", async () => {
    h.user = "";
    await expect(createBankrollAction({ name: "X", unit: "50", channel: "" })).rejects.toThrow(
      /Sessão inválida/,
    );
    expect(await db.prisma.bankroll.count()).toBe(0);
  });

  it("unidade não-positiva é rejeitada, não vira 0u calado", async () => {
    expect(await recusa(createBankrollAction({ name: "X", unit: "abc", channel: "" }))).toMatch(/unidade/i);
    expect(await recusa(createBankrollAction({ name: "X", unit: "0", channel: "" }))).toMatch(/unidade/i);
    expect(await recusa(createBankrollAction({ name: "X", unit: "0.004", channel: "" }))).toMatch(/unidade/i);
    expect(await db.prisma.bankroll.count()).toBe(0);
  });

  it("nome vazio é rejeitado", async () => {
    expect(await recusa(createBankrollAction({ name: "   ", unit: "50", channel: "" }))).toMatch(/nome/i);
  });

  it("rejeita nome excessivo antes de persistir", async () => {
    expect(await recusa(createBankrollAction({
      name: "x".repeat(121),
      unit: "50",
      channel: "",
    }))).toMatch(/120 caracteres/i);
    expect(await db.prisma.bankroll.count()).toBe(0);
  });

  it("rejeita channelId fora do int8 antes de consultar o PostgreSQL", async () => {
    expect(await recusa(createBankrollAction({
      name: "Canal fora do limite",
      unit: "50",
      channel: "99999999999999999999",
    }))).toMatch(/limite numérico/i);
    expect(await recusa(createBankrollAction({
      name: "Canal negativo fora do limite",
      unit: "50",
      channel: "-99999999999999999999",
    }))).toMatch(/limite numérico/i);
    expect(await db.prisma.bankroll.count()).toBe(0);
  });
});

describe("aliases de mercado pela Config", () => {
  it("adicionar e remover gravam quem ensinou, na mesma transação do alias", async () => {
    const mercado = await db.prisma.mercadoPadrao.create({ data: { nome: "Moneyline" } });
    await addMarketAliasAction("Moneyline", "  Vencedor do jogo ");
    const alias = await db.prisma.mercadoAlias.findFirstOrThrow({ where: { mercadoPadraoId: mercado.id } });
    expect(alias.alias).toBe("Vencedor do jogo");
    await removeMarketAliasAction("Moneyline", "Vencedor do jogo");
    expect(await db.prisma.mercadoAlias.count()).toBe(0);
    const audit = await db.prisma.auditEvent.findMany({ where: { resource: "market_alias" }, orderBy: { createdAt: "asc" } });
    expect(audit.map((row) => [row.action, row.actor, row.resourceId])).toEqual([
      ["market_alias.create", "tester", alias.id],
      ["market_alias.delete", "tester", alias.id],
    ]);
  });

  it("variante normalizada atualiza uma só linha, que continua removível pela grafia nova", async () => {
    const mercado = await db.prisma.mercadoPadrao.create({ data: { nome: "Moneyline" } });
    await addMarketAliasAction("Moneyline", "Vencedor do jogo");
    await addMarketAliasAction("Moneyline", "vencedor DO jogo");
    expect(await db.prisma.mercadoAlias.findMany({ where: { mercadoPadraoId: mercado.id }, select: { alias: true } })).toEqual([{ alias: "vencedor DO jogo" }]);
    await removeMarketAliasAction("Moneyline", "vencedor DO jogo");
    expect(await db.prisma.mercadoAlias.count()).toBe(0);
  });

  it("recusa entrada fora do contrato antes de gravar", async () => {
    await db.prisma.mercadoPadrao.create({ data: { nome: "Moneyline" } });
    const hostile: Array<[unknown, unknown]> = [
      ["Moneyline", "x".repeat(201)],
      ["Moneyline", "   "],
      ["Moneyline", { alias: "objeto" }],
      [42, "Vencedor"],
    ];
    for (const [canon, alias] of hostile) {
      expect(await recusa(addMarketAliasAction(canon as string, alias as string))).toMatch(/Alias de mercado inválido/);
    }
    expect(await db.prisma.mercadoAlias.count()).toBe(0);
  });

  it("sem sessão é BARRADO", async () => {
    await db.prisma.mercadoPadrao.create({ data: { nome: "Moneyline" } });
    h.user = "";
    await expect(addMarketAliasAction("Moneyline", "Vencedor")).rejects.toThrow(/Sessão inválida/);
    expect(await db.prisma.mercadoAlias.count()).toBe(0);
  });
});

describe("logo da banca", () => {
  it("preserva o acesso à logo de endereço longo já gerado", async () => {
    const slug = `${"x".repeat(120)}-2`;
    const bank = await db.prisma.bankroll.create({ data: { nome: "Existente", slug, valorUnidade: 100 } });
    await expect(removeLogoAction(slug)).resolves.toEqual({ ok: true });
    expect((await db.prisma.bankroll.findUniqueOrThrow({ where: { id: bank.id } })).slug).toBe(slug);
  });

  it("não remove arquivo para slug sem banca ativa", async () => {
    expect(await recusa(removeLogoAction("nao-existe"))).toMatch(/não encontrado/i);
  });

  it("trocar e remover a logo ficam na trilha com o operador da sessão", async () => {
    const bk = await db.prisma.bankroll.create({ data: { nome: "Logo", slug: "logo", valorUnidade: 10 } });
    // PNG de 1×1: o upload valida o formato pelo conteúdo.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const uploaded = await uploadLogoAction("logo", new File([png], "logo.png", { type: "image/png" }));
    expect(uploaded).toMatchObject({ ok: true, logoUrl: expect.stringContaining("logo") });
    await expect(removeLogoAction("logo")).resolves.toEqual({ ok: true });
    const trilha = await db.prisma.auditEvent.findMany({
      where: { resource: "bankroll", resourceId: bk.id, action: { startsWith: "logo." } },
      orderBy: { createdAt: "asc" },
      select: { action: true, actor: true, details: true },
    });
    expect(trilha).toEqual([
      { action: "logo.upload", actor: "tester", details: { slug: "logo" } },
      { action: "logo.delete", actor: "tester", details: { slug: "logo" } },
    ]);
  });

  it("arquivo que não é imagem aceita volta como recusa com a mensagem", async () => {
    await db.prisma.bankroll.create({ data: { nome: "Formato", slug: "formato", valorUnidade: 10 } });
    const gif = new File([Buffer.from("GIF89a")], "logo.gif", { type: "image/gif" });
    expect(await recusa(uploadLogoAction("formato", gif))).toBe("Formato inválido — envie JPG, PNG ou WebP.");
    // Cabeçalho de PNG com o corpo quebrado: o reencode recusa.
    const quebrado = new File([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")], "logo.png", { type: "image/png" });
    expect(await recusa(uploadLogoAction("formato", quebrado))).toBe("Imagem inválida ou corrompida.");
  });

  it("logo grande demais volta como recusa com a mensagem", async () => {
    await db.prisma.bankroll.create({ data: { nome: "Grande", slug: "grande", valorUnidade: 10 } });
    const enorme = new File([new Uint8Array(3 * 1024 * 1024)], "logo.png", { type: "image/png" });
    expect(await recusa(uploadLogoAction("grande", enorme))).toMatch(/Logo grande demais/);
  });

  it("sem sessão é barrado", async () => {
    await db.prisma.bankroll.create({ data: { nome: "Sessao", slug: "sessao", valorUnidade: 10 } });
    h.user = "";
    await expect(removeLogoAction("sessao")).rejects.toThrow(/Sessão inválida/);
  });
});

describe("nomes de tipster na ficha do time", () => {
  async function fichaComNome() {
    const card = await db.prisma.teamCard.create({ data: {
      sport: "Soccer", flashscoreTeamId: "8hWKNqzL", flashscoreName: "Fenix", country: "Uruguay", category: "principal", lastSeenAt: new Date(),
    } });
    const name = await db.prisma.teamTipsterName.create({ data: {
      cardId: card.id, sport: "Soccer", name: "Fenix MVD", nameNorm: "fenix mvd", firstBetId: "bet-1", firstDay: "2026-09-24", category: "principal", firstPinnacleEventId: "p17-1",
    } });
    return { card, name };
  }

  it("remover tira só o nome, com o operador da sessão na trilha", async () => {
    const { card, name } = await fichaComNome();
    await expect(removeTipsterNameAction(name.id)).resolves.toEqual({ ok: true });

    expect(await db.prisma.teamTipsterName.count()).toBe(0);
    expect(await db.prisma.teamCard.count({ where: { id: card.id } })).toBe(1);
    const audit = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "team_tipster_name.delete" } });
    expect(audit).toMatchObject({ actor: "tester", resource: "team_tipster_name", resourceId: name.id });
    expect(audit.details).toMatchObject({ cardId: card.id, name: "Fenix MVD", status: "pending", flashscoreTeamId: "8hWKNqzL" });
  });

  it("o nome que já saiu volta como recusa, sem nova trilha", async () => {
    const { name } = await fichaComNome();
    await removeTipsterNameAction(name.id);
    expect(await recusa(removeTipsterNameAction(name.id))).toMatch(/já tinha sido removido/);
    expect(await db.prisma.auditEvent.count({ where: { action: "team_tipster_name.delete" } })).toBe(1);
  });

  it("sem sessão é BARRADO, e id malformado não chega ao banco", async () => {
    const { name } = await fichaComNome();
    await expect(removeTipsterNameAction("não-é-uuid")).rejects.toThrow(/inválido/);
    h.user = "";
    await expect(removeTipsterNameAction(name.id)).rejects.toThrow(/Sessão inválida/);
    await expect(loadTeamCardsAction()).rejects.toThrow(/Sessão inválida/);
    expect(await db.prisma.teamTipsterName.count()).toBe(1);
    expect(await db.prisma.auditEvent.count()).toBe(0);
  });

  it("a busca da tela passa pela action e recusa entrada fora do contrato", async () => {
    await fichaComNome();
    expect((await loadTeamCardsAction({ query: "mvd" })).cards.map((card) => card.flashscoreTeamId)).toEqual(["8hWKNqzL"]);
    await expect(loadTeamCardsAction({ query: "x".repeat(101) })).rejects.toThrow(/Busca de times inválida/);
    await expect(loadTeamCardsAction({ offset: -1 })).rejects.toThrow(/Busca de times inválida/);
  });
});

describe("editarBankrollAction (Postgres real + borda mockada)", () => {
  it("edição parcial no serviço preserva o canal quando ele é omitido", async () => {
    const bk = await db.prisma.bankroll.create({
      data: {
        nome: "Canal parcial",
        slug: "canal-parcial",
        valorUnidade: 10,
        telegramChannelId: -1001234567890n,
      },
    });
    await editarBankroll(bk.id, {
      nome: "Canal parcial editado",
      valorUnidade: 20,
      sharpMode: "CLV_ONLY",
      capturePolicy: "AUTO",
    });
    const after = await db.prisma.bankroll.findUniqueOrThrow({ where: { id: bk.id } });
    expect(after.telegramChannelId).toBe(-1001234567890n);
  });

  it("admin edita nome/unidade/canal/sharpMode e PRESERVA capital/vínculo/bookmaker", async () => {
    const bk = await db.prisma.bankroll.create({
      data: {
        nome: "Velha",
        slug: "velha",
        valorUnidade: 10,
        capitalInicial: 250,
        vincularContas: false,
        defaultBookmaker: "Pinnacle",
        sharpMode: "CLV_ONLY",
        capturePolicy: "AUTO",
      },
    });
    await editarBankrollAction({
      id: bk.id,
      name: "Nova",
      unit: "75",
      channel: "-1001234567890",
      sharpMode: "CLV_ONLY",
      capturePolicy: "CAPTION_ODD",
    });
    const after = await db.prisma.bankroll.findUniqueOrThrow({ where: { id: bk.id } });
    expect(after.nome).toBe("Nova");
    expect(toNumber(after.valorUnidade)).toBe(75);
    expect(after.telegramChannelId).toBe(-1001234567890n);
    expect(after.sharpMode).toBe("CLV_ONLY");
    expect(after.slug).toBe("velha"); // slug é imutável
    // campos fora do form são preservados (não zerados):
    expect(toNumber(after.capitalInicial)).toBe(250);
    expect(after.vincularContas).toBe(false);
    expect(after.defaultBookmaker).toBe("Pinnacle");
  });

  it("marca os esportes do canal e pausa a captura sem perder o instante da pausa", async () => {
    const bk = await db.prisma.bankroll.create({ data: { nome: "Cesta", slug: "cesta", valorUnidade: 10 } });
    await db.prisma.bet.create({ data: {
      bankrollId: bk.id, data: new Date(), evento: "Mogi vs Franca", esporte: "Basketball", mercado: "Total", selecao: "Over 150.5",
      odds: 1.9, stake: 1, sportResolutionStatus: "CONFIRMED", sportSource: "TEAM_ID", sportResolvedAt: new Date(),
    } });
    const fields = { id: bk.id, name: "Cesta", unit: "10", channel: "", sharpMode: "CLV_ONLY" as const, capturePolicy: "AUTO" as const };
    await editarBankrollAction({ ...fields, channelSports: ["basquete", "Basketball"], capturePaused: true });
    const paused = await db.prisma.bankroll.findUniqueOrThrow({ where: { id: bk.id } });
    expect(paused.channelSports).toEqual(["Basketball"]);
    expect(paused.capturePausedAt).toBeInstanceOf(Date);
    expect((await getConfigPageData()).bankrolls[0]).toMatchObject({
      channelSports: ["Basketball"], capturePausedAt: paused.capturePausedAt, confirmedSports: [{ sport: "Basketball", bets: 1 }],
    });
    await editarBankrollAction({ ...fields, channelSports: ["Basketball"], capturePaused: true });
    expect((await db.prisma.bankroll.findUniqueOrThrow({ where: { id: bk.id } })).capturePausedAt).toEqual(paused.capturePausedAt);
    expect(await recusa(editarBankrollAction({ ...fields, channelSports: ["Quadribol"] }))).toMatch(/Esporte desconhecido/);
    await editarBankrollAction({ ...fields, channelSports: [], capturePaused: false });
    expect(await db.prisma.bankroll.findUniqueOrThrow({ where: { id: bk.id } })).toMatchObject({ channelSports: [], capturePausedAt: null });
    expect(await db.prisma.auditEvent.findMany({ where: { action: "bankroll.update", resourceId: bk.id }, select: { details: true }, orderBy: { createdAt: "asc" } }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ details: expect.objectContaining({ capturePaused: true, channelSports: ["Basketball"] }) })]));
  });

  it("aceita unidade brasileira ao editar", async () => {
    const bk = await db.prisma.bankroll.create({
      data: { nome: "BR", slug: "br", valorUnidade: 10 },
    });
    await editarBankrollAction({
      id: bk.id,
      name: "BR",
      unit: "75,25",
      channel: "",
      sharpMode: "CLV_ONLY",
      capturePolicy: "AUTO",
    });
    const after = await db.prisma.bankroll.findUniqueOrThrow({ where: { id: bk.id } });
    expect(toNumber(after.valorUnidade)).toBe(75.25);
  });

  it("sem sessão é BARRADO (regressão de autorização)", async () => {
    const bk = await db.prisma.bankroll.create({
      data: { nome: "X", slug: "x", valorUnidade: 10 },
    });
    h.user = "";
    await expect(
      editarBankrollAction({ id: bk.id, name: "Y", unit: "10", channel: "", sharpMode: "CLV_ONLY", capturePolicy: "AUTO" }),
    ).rejects.toThrow(/Sessão inválida/);
    const after = await db.prisma.bankroll.findUniqueOrThrow({ where: { id: bk.id } });
    expect(after.nome).toBe("X");
  });

  it("unidade inválida e sharpMode inválido são rejeitados", async () => {
    const bk = await db.prisma.bankroll.create({
      data: { nome: "X", slug: "x", valorUnidade: 10 },
    });
    expect(await recusa(editarBankrollAction({ id: bk.id, name: "X", unit: "0", channel: "", sharpMode: "CLV_ONLY", capturePolicy: "AUTO" }))).toMatch(/unidade/i);
    // @ts-expect-error sharpMode fora do enum é rejeitado em runtime
    expect(await recusa(editarBankrollAction({ id: bk.id, name: "X", unit: "10", channel: "", sharpMode: "NOPE", capturePolicy: "AUTO" }))).toMatch(/sharp/i);
  });

  it("id inválido ou inexistente é rejeitado com mensagem acionável", async () => {
    // Id malformado é defeito do cliente (erro); banca que não existe é recusa.
    await expect(editarBankrollAction({ id: "nao-existe", name: "X", unit: "10", channel: "", sharpMode: "CLV_ONLY", capturePolicy: "AUTO" })).rejects.toThrow(/inválido/i);
    expect(await recusa(editarBankrollAction({
      id: "00000000-0000-4000-8000-000000000001",
      name: "X",
      unit: "10",
      channel: "",
      sharpMode: "CLV_ONLY",
      capturePolicy: "AUTO",
    }))).toMatch(/encontrado/i);
  });
});

describe("excluirBankrollAction (Postgres real + borda mockada)", () => {
  it("admin exclui permanentemente, libera canal e slug, e a banca some do Config", async () => {
    const bk = await db.prisma.bankroll.create({
      data: { nome: "Del", slug: "del", valorUnidade: 10, telegramChannelId: 1002n },
    });
    await expect(excluirBankrollAction({ id: bk.id, expectedBetCount: 0 })).resolves.toEqual({ ok: true });
    expect(await db.prisma.bankroll.findUnique({ where: { id: bk.id } })).toBeNull();
    const { bankrolls } = await getConfigPageData();
    expect(bankrolls.find((b) => b.id === bk.id)).toBeUndefined();

    const recreated = await createBankrollAction({ name: "Del", unit: "10", channel: "10002" });
    expect(recreated).toMatchObject({ ok: true, slug: "del" });
  });

  it("sem sessão é BARRADO (regressão de autorização)", async () => {
    const bk = await db.prisma.bankroll.create({
      data: { nome: "Del", slug: "del", valorUnidade: 10 },
    });
    h.user = "";
    await expect(excluirBankrollAction({ id: bk.id, expectedBetCount: 0 })).rejects.toThrow(/Sessão inválida/);
    const after = await db.prisma.bankroll.findUniqueOrThrow({ where: { id: bk.id } });
    expect(after.nome).toBe("Del");
  });

  it("exclui também as apostas pendentes da banca", async () => {
    const bk = await db.prisma.bankroll.create({
      data: { nome: "Pendente", slug: "pendente", valorUnidade: 10 },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bk.id,
        data: new Date("2026-07-15T15:00:00Z"),
        evento: "A vs B",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "A",
        odds: 2,
        stake: 1,
      },
    });

    await excluirBankrollAction({ id: bk.id, expectedBetCount: 1 });
    expect(await db.prisma.bankroll.findUnique({ where: { id: bk.id } })).toBeNull();
    expect(await db.prisma.bet.findUnique({ where: { id: bet.id } })).toBeNull();
  });

  it("recusa quando uma aposta chegou depois da confirmação, sem apagar nada", async () => {
    const bk = await db.prisma.bankroll.create({
      data: { nome: "Viva", slug: "viva", valorUnidade: 10 },
    });
    // O modal mostrou 0 apostas; a captura gravou uma enquanto ele estava aberto.
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(), bankrollId: bk.id,
        data: new Date("2026-07-15T15:00:00Z"), evento: "A vs B", esporte: "Soccer",
        mercado: "Moneyline", selecao: "A", odds: 2, stake: 1,
      },
    });

    const result = await excluirBankrollAction({ id: bk.id, expectedBetCount: 0 });
    expect(result).toMatchObject({ ok: false, betCount: 1 });
    expect(result.ok ? "" : result.erro).toMatch(/agora tem 1 aposta, não 0/);
    expect(await db.prisma.bankroll.findUnique({ where: { id: bk.id } })).not.toBeNull();
    expect(await db.prisma.bet.findUnique({ where: { id: bet.id } })).not.toBeNull();
    expect(await db.prisma.auditEvent.count({ where: { action: "bankroll.delete" } })).toBe(0);
  });

  it("recusa confirmação sem o total visto ou com total inválido", async () => {
    const bk = await db.prisma.bankroll.create({ data: { nome: "Del", slug: "del", valorUnidade: 10 } });
    for (const input of [{ id: bk.id }, { id: bk.id, expectedBetCount: -1 }, { id: bk.id, expectedBetCount: 0.5 }]) {
      await expect(excluirBankrollAction(input as { id: string; expectedBetCount: number })).rejects.toThrow(/Tipster inválido/);
    }
    expect(await db.prisma.bankroll.findUnique({ where: { id: bk.id } })).not.toBeNull();
  });
});
