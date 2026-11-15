import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Server actions de Contas contra Postgres real (financeiro testa contra banco),
 * borda Next mockada. Cobre autorização (requireSession), validação de input hostil
 * e o efeito no ledger (saldo + movimentação na MESMA transação).
 */
const h = vi.hoisted(() => ({ user: "tester" }));
vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (k: string) => (k === "x-auth-user" ? h.user : null),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { createTestDb, type TestDb } from "../helpers/db";
import { observeAction } from "@/src/services/ops/telemetry";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";
import {
  alterarStatusContaAction,
  criarContaAction as criarContaActionReal,
  editarContaAction,
  movimentarContaAction as movimentarContaActionReal,
  removerContaAction,
} from "@/app/(painel)/contas/actions";
import { toNumber } from "@/src/domain/money";

let db: TestDb;
beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.dispose();
});
beforeEach(async () => {
  await db.reset();
  h.user = "tester";
});

async function novaConta(saldo = 100) {
  return db.prisma.conta.create({
    data: { casaDeAposta: "Bet365", titular: "Fabricio", saldoInicial: saldo, saldoAtual: saldo },
    select: { id: true },
  });
}

function criarContaAction(input: Omit<Parameters<typeof criarContaActionReal>[0], "requestId"> & { requestId?: string }) {
  return criarContaActionReal({ ...input, requestId: input.requestId ?? randomUUID() });
}

function movimentarContaAction(
  input: Omit<Parameters<typeof movimentarContaActionReal>[0], "clientMutationId"> & {
    clientMutationId?: string;
  },
) {
  return movimentarContaActionReal({
    ...input,
    clientMutationId: input.clientMutationId ?? randomUUID(),
  });
}

/**
 * Recusa de NEGÓCIO volta como `{ ok: false, erro }`, não como exceção.
 *
 * Server action que lança perde a mensagem em produção — o Next entrega
 * "An error occurred in the Server Components render… digest" e o operador vê
 * isso no toast em vez do motivo. Falha de AUTORIZAÇÃO continua exceção, e os
 * casos de sessão abaixo provam.
 */
async function recusa(promessa: Promise<{ ok: boolean } & Record<string, unknown>>) {
  const res = await promessa;
  expect(res.ok, JSON.stringify(res)).toBe(false);
  return String((res as { erro?: unknown }).erro ?? "");
}

describe("criarContaAction", () => {
  it("recusa criação sem identificador e repete um pedido confirmado sem outro depósito", async () => {
    const input = { casaDeAposta: "Bet365", titular: "Teste", saldoInicial: 100 };
    expect(await criarContaActionReal(input as Parameters<typeof criarContaActionReal>[0])).toMatchObject({ ok: false });
    expect(await db.prisma.conta.count()).toBe(0);
    const request = { ...input, requestId: randomUUID() };
    expect(await criarContaActionReal(request)).toMatchObject({ ok: true });
    expect(await criarContaActionReal(request)).toMatchObject({ ok: true });
    expect(await db.prisma.conta.count()).toBe(1);
    expect(await db.prisma.movimentacao.count()).toBe(1);
  });

  it("admin cria conta e registra o depósito do saldo inicial", async () => {
    await criarContaAction({ casaDeAposta: "Bet365", titular: "Fabricio", saldoInicial: 500 });
    const conta = await db.prisma.conta.findFirstOrThrow({ where: { casaDeAposta: "Bet365" } });
    expect(toNumber(conta.saldoAtual)).toBe(500);
    const movs = await db.prisma.movimentacao.findMany({ where: { contaId: conta.id } });
    expect(movs).toHaveLength(1);
    expect(movs[0]!.tipo).toBe("DEPOSITO");
    expect(toNumber(movs[0]!.valor)).toBe(500);
    expect(movs[0]!.actor).toBe("tester");
  });

  it("vincula bankrolls informados", async () => {
    const bk = await db.prisma.bankroll.create({
      data: { nome: "Big Data", slug: "big-data", valorUnidade: 1, capitalInicial: 100 },
      select: { id: true },
    });
    await criarContaAction({
      casaDeAposta: "Pinnacle",
      titular: "Fabricio",
      saldoInicial: 0,
      bankrollIds: [bk.id, bk.id],
    });
    const conta = await db.prisma.conta.findFirstOrThrow({ where: { casaDeAposta: "Pinnacle" } });
    const links = await db.prisma.contaBankroll.findMany({ where: { contaId: conta.id } });
    expect(links.map((l) => l.bankrollId)).toEqual([bk.id]);
  });

  it("recusa vínculo com banca removida, sem criar a conta", async () => {
    const bk = await db.prisma.bankroll.create({
      data: {
        nome: "Morta",
        slug: "morta",
        valorUnidade: 1,
        capitalInicial: 100,
      },
      select: { id: true },
    });
    await db.prisma.bankroll.delete({ where: { id: bk.id } });
    expect(await recusa(
      criarContaAction({
        casaDeAposta: "Betfair",
        titular: "Fabricio",
        saldoInicial: 0,
        bankrollIds: [bk.id],
      }),    )).toMatch(new RegExp(bk.id));
    expect(await db.prisma.conta.count({ where: { casaDeAposta: "Betfair" } })).toBe(0);
  });

  it("sem sessão é BARRADO (autorização)", async () => {
    h.user = "";
    await expect(
      criarContaAction({ casaDeAposta: "X", titular: "Y", saldoInicial: 0 }),
    ).rejects.toThrow(/Sessão inválida/);
    expect(await db.prisma.conta.count()).toBe(0);
  });
});

describe("movimentarContaAction (ledger)", () => {
  it("recusa chamada legada sem chave de idempotência", async () => {
    const conta = await novaConta(100);
    const semChave = { contaId: conta.id, tipo: "DEPOSITO", valor: 50 } as unknown as
      Parameters<typeof movimentarContaActionReal>[0];
    expect(await recusa(movimentarContaActionReal(semChave))).toMatch(/idempot/i);
    expect(await db.prisma.movimentacao.count({ where: { contaId: conta.id } })).toBe(0);
  });

  it("depósito credita saldo e grava movimentação positiva", async () => {
    const conta = await novaConta(100);
    await movimentarContaAction({ contaId: conta.id, tipo: "DEPOSITO", valor: 50 });
    const c = await db.prisma.conta.findFirstOrThrow({ where: { id: conta.id } });
    expect(toNumber(c.saldoAtual)).toBe(150);
    const mov = await db.prisma.movimentacao.findFirstOrThrow({ where: { contaId: conta.id } });
    expect(toNumber(mov.valor)).toBe(50);
    expect(toNumber(mov.saldoApos)).toBe(150);
    expect(mov.actor).toBe("tester");
  });

  it("saque debita (valor negativo no ledger)", async () => {
    const conta = await novaConta(100);
    await movimentarContaAction({ contaId: conta.id, tipo: "SAQUE", valor: 30 });
    const c = await db.prisma.conta.findFirstOrThrow({ where: { id: conta.id } });
    expect(toNumber(c.saldoAtual)).toBe(70);
    const mov = await db.prisma.movimentacao.findFirstOrThrow({ where: { contaId: conta.id } });
    expect(toNumber(mov.valor)).toBe(-30);
  });

  it("duplo clique com a MESMA chave grava uma linha só e não dobra o saldo", async () => {
    const conta = await novaConta(100);
    const mutId = "11111111-2222-3333-4444-555555555555";
    const mov = {
      contaId: conta.id,
      tipo: "DEPOSITO" as const,
      valor: 500,
      clientMutationId: mutId,
    };

    await movimentarContaAction(mov);
    await movimentarContaAction(mov);

    const linhas = await db.prisma.movimentacao.findMany({ where: { contaId: conta.id } });
    expect(linhas).toHaveLength(1);
    expect(toNumber(linhas[0]!.valor)).toBe(500);
    const c = await db.prisma.conta.findFirstOrThrow({ where: { id: conta.id } });
    expect(toNumber(c.saldoAtual)).toBe(600);
  });

  it("dois submits no MESMO tick também gravam uma linha só", async () => {
    // Chave própria e nenhuma chamada anterior: aqui as duas transações correm
    // de verdade, e quem perde cai no unique (P2002) — a transação inteira
    // rola para trás, então o increment do saldo não acontece duas vezes.
    const conta = await novaConta(100);
    const mov = {
      contaId: conta.id,
      tipo: "DEPOSITO" as const,
      valor: 500,
      clientMutationId: "99999999-8888-7777-6666-555555555555",
    };

    await Promise.all([movimentarContaAction(mov), movimentarContaAction(mov)]);

    expect(await db.prisma.movimentacao.count({ where: { contaId: conta.id } })).toBe(1);
    const c = await db.prisma.conta.findFirstOrThrow({ where: { id: conta.id } });
    expect(toNumber(c.saldoAtual)).toBe(600);
  });

  it("chaves diferentes registram depósitos idênticos separadamente", async () => {
    const conta = await novaConta(0);
    await movimentarContaAction({
      contaId: conta.id,
      tipo: "DEPOSITO",
      valor: 500,
      clientMutationId: "aaaaaaaa-1111-2222-3333-444444444444",
    });
    await movimentarContaAction({
      contaId: conta.id,
      tipo: "DEPOSITO",
      valor: 500,
      clientMutationId: "bbbbbbbb-1111-2222-3333-444444444444",
    });
    const c = await db.prisma.conta.findFirstOrThrow({ where: { id: conta.id } });
    expect(toNumber(c.saldoAtual)).toBe(1000);
    expect(await db.prisma.movimentacao.count({ where: { contaId: conta.id } })).toBe(2);
  });

  it("a mesma chave não pode representar dinheiro de outra conta", async () => {
    const a = await novaConta(0);
    const b = await db.prisma.conta.create({
      data: { casaDeAposta: "Betano", titular: "Outra", saldoInicial: 0, saldoAtual: 0 },
    });
    const clientMutationId = "cccccccc-1111-2222-3333-444444444444";
    await movimentarContaAction({
      contaId: a.id,
      tipo: "DEPOSITO",
      valor: 100,
      clientMutationId,
    });
    expect(await recusa(
      movimentarContaAction({
        contaId: b.id,
        tipo: "DEPOSITO",
        valor: 200,
        clientMutationId,
      }),    )).toMatch(/outra movimentação/i);
    expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: b.id } })).saldoAtual))
      .toBe(0);
  });

  it("chave de idempotência malformada é recusada na borda", async () => {
    const conta = await novaConta(100);
    expect(await recusa(
      movimentarContaAction({
        contaId: conta.id,
        tipo: "DEPOSITO",
        valor: 10,
        clientMutationId: "curto",
      }),    )).toMatch(/idempot/i);
    expect(await db.prisma.movimentacao.count({ where: { contaId: conta.id } })).toBe(0);
  });

  it("saque maior que o saldo é rejeitado e não altera nada", async () => {
    const conta = await novaConta(40);
    expect(await recusa(
      movimentarContaAction({ contaId: conta.id, tipo: "SAQUE", valor: 100 }),    )).toMatch(/saldo/i);
    const c = await db.prisma.conta.findFirstOrThrow({ where: { id: conta.id } });
    expect(toNumber(c.saldoAtual)).toBe(40);
    expect(await db.prisma.movimentacao.count({ where: { contaId: conta.id } })).toBe(0);
  });

  it("tipo não-manual (GANHO_APOSTA) é rejeitado", async () => {
    const conta = await novaConta(100);
    // GANHO_APOSTA é um MovimentacaoTipo válido no tipo, mas nasce do settlement —
    // a action recusa em runtime: movimentação manual só DEPOSITO/SAQUE/AJUSTE/BONUS.
    expect(await recusa(
      movimentarContaAction({ contaId: conta.id, tipo: "GANHO_APOSTA", valor: 10 }),    )).toMatch(/inválid/i);
  });

  it("valor não-positivo é rejeitado", async () => {
    const conta = await novaConta(100);
    expect(await recusa(
      movimentarContaAction({ contaId: conta.id, tipo: "DEPOSITO", valor: 0 }),    )).toMatch(/valor/i);
  });

  it("sem sessão é BARRADO", async () => {
    const conta = await novaConta(100);
    h.user = "";
    await expect(
      movimentarContaAction({ contaId: conta.id, tipo: "DEPOSITO", valor: 10 }),
    ).rejects.toThrow(/Sessão inválida/);
    const c = await db.prisma.conta.findFirstOrThrow({ where: { id: conta.id } });
    expect(toNumber(c.saldoAtual)).toBe(100);
  });
});

describe("editarContaAction / alterarStatusContaAction / removerContaAction", () => {
  it("editar atualiza metadados sem tocar no saldo", async () => {
    const conta = await novaConta(200);
    await editarContaAction({
      contaId: conta.id,
      casaDeAposta: "Betano",
      titular: "Fabricio S.",
      apelido: "principal",
    });
    const c = await db.prisma.conta.findFirstOrThrow({ where: { id: conta.id } });
    expect(c.casaDeAposta).toBe("Betano");
    expect(c.apelido).toBe("principal");
    expect(toNumber(c.saldoAtual)).toBe(200);
  });

  it("editar com banca removida falha ANTES de destruir os vínculos bons", async () => {
    const conta = await novaConta(50);
    const viva = await db.prisma.bankroll.create({
      data: { nome: "Viva", slug: "viva", valorUnidade: 1, capitalInicial: 10 },
      select: { id: true },
    });
    const morta = await db.prisma.bankroll.create({
      data: {
        nome: "Morta2",
        slug: "morta2",
        valorUnidade: 1,
        capitalInicial: 10,
      },
      select: { id: true },
    });
    await db.prisma.bankroll.delete({ where: { id: morta.id } });
    await editarContaAction({
      contaId: conta.id,
      casaDeAposta: "Bet365",
      titular: "Fabricio",
      bankrollIds: [viva.id],
    });

    expect(await recusa(
      editarContaAction({
        contaId: conta.id,
        casaDeAposta: "Bet365",
        titular: "Fabricio",
        bankrollIds: [morta.id],
      }),    )).toMatch(new RegExp(morta.id));

    const links = await db.prisma.contaBankroll.findMany({ where: { contaId: conta.id } });
    expect(links.map((l) => l.bankrollId)).toEqual([viva.id]);
  });

  it("alterar status muda o status; status inválido é rejeitado", async () => {
    const conta = await novaConta();
    await alterarStatusContaAction(conta.id, "ATIVA", "LIMITADA");
    expect((await db.prisma.conta.findFirstOrThrow({ where: { id: conta.id } })).status).toBe(
      "LIMITADA",
    );
    expect(await recusa(
      // @ts-expect-error — input hostil: status fora do enum
      alterarStatusContaAction(conta.id, "LIMITADA", "BANIDA"),    )).toMatch(/status/i);
  });

  it("não deixa uma aba antiga sobrescrever o status mais recente", async () => {
    const conta = await novaConta();
    await alterarStatusContaAction(conta.id, "ATIVA", "LIMITADA");

    expect(await recusa(
      alterarStatusContaAction(conta.id, "ATIVA", "ENCERRADA"),    )).toMatch(/outra aba/i);
    expect((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).status)
      .toBe("LIMITADA");
  });

  it("remover faz soft-delete (deletedAt + ENCERRADA), some da listagem", async () => {
    expect(await criarContaAction({ casaDeAposta: "Bet365", titular: "Sintético", saldoInicial: 100 })).toMatchObject({ ok: true });
    const conta = await db.prisma.conta.findFirstOrThrow();
    expect(await movimentarContaAction({ contaId: conta.id, tipo: "SAQUE", valor: 100 })).toMatchObject({ ok: true });
    expect(await removerContaAction(conta.id)).toMatchObject({ ok: true });
    const c = await db.prisma.conta.findFirstOrThrow({ where: { id: conta.id } });
    expect(c.deletedAt).not.toBeNull();
    expect(c.status).toBe("ENCERRADA");
    expect(await db.prisma.conta.count({ where: { deletedAt: null } })).toBe(0);
  });

  it("remoção explica a divergência financeira mesmo com saldo zerado", async () => {
    await criarContaAction({ casaDeAposta: "Bet365", titular: "Sintético", saldoInicial: 100 });
    const conta = await db.prisma.conta.findFirstOrThrow();
    await db.prisma.conta.update({ where: { id: conta.id }, data: { saldoAtual: 0 } });
    expect(await recusa(removerContaAction(conta.id))).toMatch(/reconcilie.*saldo.*movimenta/i);
    expect((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).deletedAt).toBeNull();
  });

  it("sem sessão é BARRADO em status e remoção", async () => {
    const conta = await novaConta();
    h.user = "";
    await expect(
      alterarStatusContaAction(conta.id, "ATIVA", "LIMITADA"),
    ).rejects.toThrow(/Sessão inválida/);
    await expect(removerContaAction(conta.id)).rejects.toThrow(/Sessão inválida/);
    const c = await db.prisma.conta.findFirstOrThrow({ where: { id: conta.id } });
    expect(c.status).toBe("ATIVA");
    expect(c.deletedAt).toBeNull();
  });
});

/**
 * Recusa de negócio não é falha de sistema.
 *
 * Excluir conta com saldo é recusado, e isso é a regra funcionando: se contasse
 * como erro, a SLO de `conta.delete` despencaria e abriria ação no painel contra
 * o próprio sistema. `expected_retry` fica fora de `successPct`.
 */
describe("recusa de negócio na telemetria", () => {
  // As métricas ficam desligadas em teste por padrão; aqui elas SÃO o assunto.
  beforeAll(() => { process.env.OBSERVABILITY_METRICS_IN_TEST = "true"; });
  afterAll(() => { delete process.env.OBSERVABILITY_METRICS_IN_TEST; });

  it("excluir conta com saldo não conta como ERRO da ação", async () => {
    const conta = await novaConta(100);

    expect(await recusa(removerContaAction(conta.id))).toMatch(/zere o saldo/i);

    const amostras = await db.prisma.operationalMetric.findMany({
      where: { kind: "action", name: "conta.delete" },
      select: { outcome: true },
    });
    expect(amostras.map((a) => a.outcome)).toEqual(["expected_retry"]);
    // A conta continua viva — a recusa não é meio-caminho.
    expect((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).deletedAt)
      .toBeNull();
  });

  /**
   * Vale também para criar, editar e trocar status: recusam pelas mesmas
   * razões — campo obrigatório, texto longo demais, conta alterada em outra
   * aba — e não podem derrubar a própria SLO.
   */
  it.each([
    {
      acao: "conta.create",
      chamada: () => criarContaAction({ casaDeAposta: "", titular: "", saldoInicial: 0 }),
      esperado: /obrigat/i,
    },
    {
      acao: "conta.update",
      chamada: async () => {
        const conta = await novaConta(0);
        return editarContaAction({
          contaId: conta.id,
          casaDeAposta: "Bet365",
          titular: "x".repeat(400),
        });
      },
      esperado: /excede/i,
    },
    {
      acao: "conta.status",
      chamada: async () => {
        const conta = await novaConta(0);
        // Estado esperado divergente = outra aba mexeu antes. Recusa, não falha.
        return alterarStatusContaAction(conta.id, "LIMITADA", "ENCERRADA");
      },
      esperado: /outra aba/i,
    },
  ])("$acao: recusa não conta como ERRO da ação", async ({ acao, chamada, esperado }) => {
    expect(await recusa(chamada())).toMatch(esperado);

    const amostras = await db.prisma.operationalMetric.findMany({
      where: { kind: "action", name: acao },
      select: { outcome: true },
    });
    expect(amostras).not.toHaveLength(0);
    expect(amostras.every((a) => a.outcome === "expected_retry")).toBe(true);
  });

  it("falha de verdade continua contando como ERRO", async () => {
    // Direto no observador: é ali que mora a classificação, e a diferença entre
    // "recusei" e "quebrei" precisa estar no TIPO, não numa string de mensagem.
    await expect(
      observeAction("teste.recusa", async () => {
        throw new RecusaDeNegocioError("regra disse não");
      }),
    ).rejects.toThrow(/regra disse não/);
    await expect(
      observeAction("teste.quebra", async () => {
        throw new Error("banco caiu");
      }),
    ).rejects.toThrow(/banco caiu/);

    const porNome = async (name: string) =>
      (await db.prisma.operationalMetric.findMany({
        where: { kind: "action", name },
        select: { outcome: true },
      })).map((a) => a.outcome);

    expect(await porNome("teste.recusa")).toEqual(["expected_retry"]);
    expect(await porNome("teste.quebra")).toEqual(["error"]);
  });
});

describe("contrato de entrada das ações de Contas", () => {
  type Criar = Parameters<typeof criarContaAction>[0];
  type Editar = Parameters<typeof editarContaAction>[0];

  it("tipo errado vira recusa legível, não TypeError", async () => {
    expect(await recusa(criarContaAction({ casaDeAposta: 42, titular: "Y", saldoInicial: 0 } as unknown as Criar)))
      .toBe("Casa inválida.");
    expect(await recusa(criarContaAction({ casaDeAposta: "Bet365", titular: "Y", saldoInicial: "10" } as unknown as Criar)))
      .toBe("Saldo inicial inválido.");
    const conta = await novaConta(50);
    expect(await recusa(editarContaAction({ contaId: conta.id, casaDeAposta: "Bet365", titular: null } as unknown as Editar)))
      .toBe("Titular inválido.");
    expect(await db.prisma.conta.count()).toBe(1);
  });

  it("ids fora do formato, lista de bancas sem teto e chaves extras são recusados antes do serviço", async () => {
    const conta = await novaConta(50);
    const muitas = Array.from({ length: 101 }, () => randomUUID());
    expect(await recusa(criarContaAction({ casaDeAposta: "Bet365", titular: "Y", saldoInicial: 0, bankrollIds: muitas })))
      .toBe("Tipsters vinculados demais.");
    expect(await recusa(criarContaAction({ casaDeAposta: "Bet365", titular: "Y", saldoInicial: 0, bankrollIds: ["x"] })))
      .toBe("Tipster vinculado inválido.");
    expect(await recusa(editarContaAction({ contaId: "x' OR 1=1", casaDeAposta: "Bet365", titular: "Y" })))
      .toBe("Conta inválida.");
    expect(await recusa(movimentarContaAction({ contaId: "nao-uuid", tipo: "DEPOSITO", valor: 10 })))
      .toBe("Conta inválida.");
    expect(await recusa(editarContaAction({ contaId: conta.id, casaDeAposta: "Bet365", titular: "Y", saldoAtual: 1e9 } as unknown as Editar)))
      .toBe("Dados da conta inválidos.");
    expect(await recusa(criarContaAction({ casaDeAposta: "B".repeat(5_000), titular: "Y", saldoInicial: 0 })))
      .toBe("Casa longa demais.");
    expect(await db.prisma.conta.count()).toBe(1);
    expect(await db.prisma.movimentacao.count()).toBe(0);
  });
});
