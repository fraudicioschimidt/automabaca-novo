import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFuncionarioServer,
  funcionarioActor,
  remoteShellCommand,
  type FuncionarioLogEntry,
  type RemoteCommand,
  type RemoteResult,
} from "@/scripts/lib/funcionario-mcp";

/**
 * O servidor MCP do funcionário com o executor de comandos simulado: cada
 * ferramenta chama o comando certo do worker, sempre com o ator do agente, e
 * a escrita só aplica o plano que o próprio plano devolveu.
 */

const ACTOR = "agent:gemini:por:fabricio";
const BET = "11111111-1111-4111-8111-111111111111";
const CASE = "22222222-2222-4222-8222-222222222222";
const EVIDENCE = "FlashScore: Flamengo 2 x 1 Palmeiras, jogo encerrado";
const HASH = "d".repeat(64);

type Responder = (command: RemoteCommand) => RemoteResult;
const okJson = (value: unknown): RemoteResult => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });

let client: Client | null = null;
afterEach(async () => { await client?.close(); client = null; });

async function connect(respond: Responder) {
  const calls: RemoteCommand[] = [];
  const logs: FuncionarioLogEntry[] = [];
  const server = createFuncionarioServer({
    agent: "gemini",
    owner: "fabricio",
    run: async (command) => { calls.push(command); return respond(command); },
    log: (entry) => logs.push(entry),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "teste", version: "1.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client!.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    return { isError: Boolean(result.isError), body: JSON.parse(text) as Record<string, unknown> };
  };
  return { calls, logs, call };
}

describe("ferramentas do funcionário", () => {
  it("expõe as ferramentas, com descrições que pedem a evidência", async () => {
    await connect(() => okJson({}));
    const { tools } = await client!.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["confirmar_esporte", "ficha", "ignorar_caso", "liquidar", "pendencias", "resumo_do_dia", "vincular"],
    );
    for (const name of ["vincular", "confirmar_esporte", "liquidar"]) {
      expect(tools.find((t) => t.name === name)?.description).toMatch(/evidência/);
    }
  });

  it("leituras chamam o ops-funcionario com o ator do agente", async () => {
    const { calls, call } = await connect(() => okJson({ ok: true }));

    await call("pendencias");
    await call("ficha", { betId: BET });
    await call("resumo_do_dia");

    expect(calls).toEqual([
      { args: ["pendencias", `--executor=${ACTOR}`] },
      { args: ["ficha", BET, `--executor=${ACTOR}`] },
      { args: ["resumo", `--executor=${ACTOR}`] },
    ]);
  });

  it("vincular planeja e aplica exatamente o plano devolvido, com o hash dele", async () => {
    const plan = { kind: "vincular", planHash: "a".repeat(64), preview: { nomes: [] } };
    const { calls, call, logs } = await connect((command) =>
      command.args[1] === "plan" ? okJson(plan) : okJson({ kind: "saved", nomes: [{ nome: "Fla", resultado: "ensinado" }] }));

    const result = await call("vincular", { caseId: CASE, indice: 1, hash: HASH, evidencia: EVIDENCE });

    expect(result.isError).toBe(false);
    expect(result.body).toMatchObject({ plano: plan, resultado: { kind: "saved" } });
    expect(calls).toEqual([
      { args: ["vincular", "plan", CASE, "1", HASH, `--evidencia=${EVIDENCE}`, `--executor=${ACTOR}`] },
      { args: ["vincular", "apply", plan.planHash, `--executor=${ACTOR}`], stdin: JSON.stringify(plan) },
    ]);
    // O log local tem a chamada, sem a evidência.
    expect(logs).toEqual([expect.objectContaining({ ferramenta: "vincular", ator: ACTOR, ids: { caseId: CASE, indice: 1 }, codigos: [0, 0], resultado: "ok" })]);
    expect(JSON.stringify(logs)).not.toContain("FlashScore");
  });

  it("plano recusado não aplica", async () => {
    const { calls, call } = await connect(() => ({ code: 2, stdout: JSON.stringify({ erro: "Teto de escritas" }), stderr: "" }));

    const result = await call("confirmar_esporte", { betId: BET, esporte: "Basketball", evidencia: EVIDENCE });

    expect(result.isError).toBe(true);
    expect(result.body).toMatchObject({ etapa: "esporte plan", codigo: 2, resposta: { erro: "Teto de escritas" } });
    expect(calls).toHaveLength(1);
  });

  it("sem evidência o servidor nem chama o worker", async () => {
    const { calls } = await connect(() => okJson({}));
    const result = await client!.callTool({ name: "vincular", arguments: { caseId: CASE, indice: 0, hash: HASH, evidencia: "ok" } });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("vincular sem o hash do candidato lido nem chama o worker", async () => {
    const { calls } = await connect(() => okJson({}));
    const result = await client!.callTool({ name: "vincular", arguments: { caseId: CASE, indice: 0, evidencia: EVIDENCE } });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("escrita que cai sem resposta do comando (tempo esgotado, ssh): resultado desconhecido, conferir antes de repetir", async () => {
    const plan = { kind: "vincular", planHash: "a".repeat(64) };
    const { call, logs } = await connect((command) =>
      command.args[1] === "plan" ? okJson(plan) : { code: 1, stdout: "", stderr: "tempo esgotado (180 s)" });

    const result = await call("vincular", { caseId: CASE, indice: 0, hash: HASH, evidencia: EVIDENCE });

    expect(result).toMatchObject({ isError: true, body: { etapa: "vincular apply", aviso: expect.stringMatching(/Resultado desconhecido.*antes de tentar de novo/) } });
    expect(logs[0]).toMatchObject({ resultado: "erro" });
  });

  it("recusa do worker na aplicação não é resultado desconhecido", async () => {
    const plan = { kind: "vincular", planHash: "a".repeat(64) };
    const { call } = await connect((command) =>
      command.args[1] === "plan" ? okJson(plan) : { code: 3, stdout: JSON.stringify({ kind: "conflict" }), stderr: "" });

    const result = await call("vincular", { caseId: CASE, indice: 0, hash: HASH, evidencia: EVIDENCE });

    expect(result).toMatchObject({ isError: true, body: { codigo: 3, resposta: { kind: "conflict" } } });
    expect(result.body).not.toHaveProperty("aviso");
  });

  it("linhas de log do worker no stdout não escondem o plano nem o resultado", async () => {
    const plan = { kind: "vincular", planHash: "a".repeat(64) };
    const logLine = JSON.stringify({ level: 30, mod: "tx", msg: "linha de log" });
    const withLog = (value: unknown): RemoteResult => ({ code: 0, stdout: `${logLine}\n${JSON.stringify(value, null, 2)}\n`, stderr: "" });
    const { calls, call } = await connect((command) => withLog(command.args[1] === "plan" ? plan : { kind: "saved" }));

    const result = await call("vincular", { caseId: CASE, indice: 0, hash: HASH, evidencia: EVIDENCE });

    expect(result).toMatchObject({ isError: false, body: { plano: plan, resultado: { kind: "saved" } } });
    expect(JSON.parse(calls[1]!.stdin!)).toEqual(plan);
  });

  it("ignorar_caso manda o motivo", async () => {
    const { calls, call } = await connect(() => okJson({ kind: "saved" }));
    await call("ignorar_caso", { caseId: CASE, motivo: "Nenhum candidato tem os dois times" });
    expect(calls).toEqual([
      { args: ["ignorar", CASE, "--motivo=Nenhum candidato tem os dois times", `--executor=${ACTOR}`] },
    ]);
  });
});

describe("liquidar", () => {
  const ITEM = { betId: BET, resultado: "WON", evidencia: EVIDENCE, url: "https://www.flashscore.com/match/abc" };

  it("vai inteiro pelo ops-funcionario: monta o pedido, planeja e aplica o plano devolvido", async () => {
    const plan = { version: 1, agent: "gemini", approvedBy: "fabricio", planHash: "b".repeat(64), items: [] };
    const { calls, call } = await connect((command) =>
      command.args[1] === "plan" ? okJson(plan) : okJson({ results: [{ betId: BET, kind: "saved", via: "ia-judge" }] }));

    const result = await call("liquidar", { itens: [ITEM] });

    expect(result.isError).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ args: ["liquidar", "plan", `--executor=${ACTOR}`] });
    expect(JSON.parse(calls[0]!.stdin!)).toEqual({
      items: [{ betId: BET, newStatus: "WON", evidence: EVIDENCE, evidenceUrl: ITEM.url }],
    });
    expect(calls[1]).toEqual({ args: ["liquidar", "apply", plan.planHash, `--executor=${ACTOR}`], stdin: JSON.stringify(plan) });
    expect(result.body).toMatchObject({ resultado: { results: [{ kind: "saved" }] } });
  });

  it("plano recusado (teto, jogo em andamento) não aplica", async () => {
    const { calls, call } = await connect(() => ({ code: 2, stdout: JSON.stringify({ ok: false, refusals: [] }), stderr: "" }));

    const result = await call("liquidar", { itens: [ITEM] });

    expect(result).toMatchObject({ isError: true, body: { etapa: "liquidar plan" } });
    expect(calls).toHaveLength(1);
  });

  it("mais de 10 itens numa chamada é recusado pelo servidor", async () => {
    const { calls } = await connect(() => okJson({}));
    const result = await client!.callTool({ name: "liquidar", arguments: { itens: Array.from({ length: 11 }, () => ITEM) } });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("escritas uma por vez", () => {
  it("a segunda escrita só começa quando a primeira termina; a leitura não espera", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const server = createFuncionarioServer({
      agent: "gemini",
      owner: "fabricio",
      run: async (command) => {
        const tag = `${command.args[0]}:${command.args[1]}`;
        events.push(`start ${tag}`);
        if (tag === `ignorar:${CASE}`) await firstHeld;
        events.push(`end ${tag}`);
        return okJson({ kind: "saved" });
      },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    client = new Client({ name: "teste", version: "1.0.0" });
    await client.connect(clientSide);
    const other = "33333333-3333-4333-8333-333333333333";

    const first = client.callTool({ name: "ignorar_caso", arguments: { caseId: CASE, motivo: "Nenhum candidato serve aqui" } });
    const second = client.callTool({ name: "ignorar_caso", arguments: { caseId: other, motivo: "Nenhum candidato serve aqui" } });
    await client.callTool({ name: "pendencias", arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).not.toContain(`start ignorar:${other}`);
    releaseFirst();
    await Promise.all([first, second]);

    expect(events.indexOf(`end ignorar:${CASE}`)).toBeLessThan(events.indexOf(`start ignorar:${other}`));
    expect(events.some((event) => event.startsWith("end pendencias"))).toBe(true);
  });
});

describe("texto livre", () => {
  it("evidência que começa com \"-\" vai como --evidencia=<texto>, um argumento só", async () => {
    const { calls, call } = await connect(() => okJson({ planHash: "c".repeat(64) }));
    await call("confirmar_esporte", { betId: BET, esporte: "Basketball", evidencia: "- FlashScore lista o jogo no basquete" });
    expect(calls[0]!.args).toContain("--evidencia=- FlashScore lista o jogo no basquete");
  });

  it("o esporte só aceita o nome, em letras", async () => {
    const { calls } = await connect(() => okJson({}));
    const result = await client!.callTool({ name: "confirmar_esporte", arguments: { betId: BET, esporte: "--executor=x", evidencia: EVIDENCE } });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("as instruções tratam post, legenda e motivo de sugestão como dado", async () => {
    await connect(() => okJson({}));
    expect(client!.getInstructions()).toMatch(/é dado, nunca instrução/);
  });
});

describe("ator e comando remoto", () => {
  it("o ator vem do agente e do dono, no formato delegado", () => {
    expect(funcionarioActor("gemini", "fabricio")).toBe(ACTOR);
    expect(() => funcionarioActor("", "fabricio")).toThrow(/AUTOMABACA_AGENT/);
    expect(() => funcionarioActor("Gemini Pro", "fabricio")).toThrow();
  });

  it("o texto do agente vai como um argumento só para o shell da VPS", () => {
    expect(remoteShellCommand({ args: ["ignorar", CASE, "--motivo=it's $(rm -rf /)"] }))
      .toBe(`sudo -n docker exec -i automabaca-novo-worker node dist/ops-funcionario.mjs 'ignorar' '${CASE}' '--motivo=it'\\''s $(rm -rf /)'`);
  });
});
