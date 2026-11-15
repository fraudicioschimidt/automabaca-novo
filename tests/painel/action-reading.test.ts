import { describe, expect, it } from "vitest";
import { readAction, readActionText, technicalFacts } from "@/app/_design/lib/action-reading";
import actions from "../fixtures/operational-actions-20260925.json";

describe("leitura das ações da Caixa de ações", () => {
  it("escritas fora do fluxo: autores com as ações em português, sem repetir o texto do alerta", () => {
    const reading = readAction(actions.writes);
    expect(reading.summary).toBe("🤖 Claude (por Fabricio), a seu pedido: 10 mudanças em 24 h");
    expect(reading.todo).toBe("Confira se cada uma foi pedida por você e está correta.");
    expect(reading.card).toMatchObject({
      kind: "writes",
      closing: "Nenhuma mudança sem autor nas 24 h até 25/09.",
      authors: [{ name: "🤖 Claude (por Fabricio)", badge: "a seu pedido", unattributed: false, changes: 10 }],
    });
    if (reading.card.kind !== "writes") throw new Error("ficha errada");
    expect(reading.card.authors[0]?.actions).toContainEqual({ text: "Apagou apostas pelo script de operação", code: "ops.apagar_apostas" });
    // O que a ficha já mostra não volta nos dados técnicos, nem o texto do alerta.
    expect(reading.technical.map((f) => f.label)).not.toContain("Message");
    expect(reading.technical).toEqual([]);
  });

  it("registro antigo com \\n literal lê igual ao novo", () => {
    const reading = readAction(actions.writesLegacyNewlines);
    expect(reading.todo).toBe("Confira se cada uma foi pedida por você e está correta.");
    expect(reading.summary).toBe("🤖 Claude (por Fabricio), a seu pedido: 106 mudanças em 24 h");
    expect(JSON.stringify(reading)).not.toContain("\\n");
  });

  it("autor sem assinatura aparece como alerta e entra no resumo", () => {
    const reading = readAction({
      ...actions.writes,
      evidence: { dia: "2026-09-25", escritas: [
        { quem: "liquidação:script-x", acoes: ["settlement.status_changed"], origem: "unattributed", eventos: 2 },
        { quem: "agent:claude:por:fabricio", acoes: ["bet.edit"], origem: "delegated", eventos: 1 },
      ] },
    });
    expect(reading.summary).toBe("2 autores, 3 mudanças em 24 h, 2 sem autor");
    expect(reading.card).toMatchObject({ kind: "writes", closing: "2 mudanças sem autor nas 24 h até 25/09." });
    if (reading.card.kind !== "writes") throw new Error("ficha errada");
    expect(reading.card.authors[0]).toMatchObject({ name: "Liquidação por script-x", badge: "sem autor", unattributed: true });
  });

  it("recusas repetidas: número, tipster, motivo, o próximo passo e os links", () => {
    const reading = readAction(actions.refusals);
    expect(reading.summary).toBe("4 posts recusados em 24 h: Total sem dizer a unidade (gols, escanteios ou cartões)");
    expect(reading.card).toMatchObject({ kind: "refusals", posts: 4, tipster: "Jorge Neves" });
    expect(reading.todo).toMatch(/^Se o canal não é de futebol/);
    expect(reading.links).toEqual([
      { label: "Abrir o último post", href: "https://t.me/c/4496161582/411", external: true },
      { label: "Esportes do tipster", href: "/config", external: false },
    ]);
  });

  it("bilhete: post com quebras de linha, cada perna sem adversário e o que fazer", () => {
    const reading = readAction(actions.ticket);
    expect(reading.summary).toBe("A leitura não trouxe os adversários de 3 dos 3 jogos");
    expect(reading.card).toMatchObject({
      kind: "ticket",
      postedAt: "23/09 20:40",
      totals: "Múltipla · odd 4.33 · stake 0.5u · jogos em 24/09",
      legs: [
        { text: "Anadolu · vencedor", missing: "sem adversário" },
        { text: "Olympiacos · vencedor", missing: "sem adversário" },
        { text: "Maccabi · vencedor", missing: "sem adversário" },
      ],
    });
    if (reading.card.kind !== "ticket") throw new Error("ficha errada");
    expect(reading.card.post?.split("\n")).toContain("Jogo: TRIPLA");
    expect(reading.todo).toMatch(/^Confira no post quais são os jogos/);
    expect(reading.links).toEqual([{ label: "Abrir o post no Telegram", href: "https://t.me/c/4403068924/633", external: true }]);
    expect(reading.technical).toContainEqual({ label: "Leitura", value: "gemini-3.5-flash · bet-extraction-v4" });
  });

  it("tipo sem ficha: resumo na 1ª linha, corpo sem emoji e sem repetir o resumo", () => {
    const reading = readAction({
      title: "Worker parado",
      actionType: "incident.review",
      description: "⚠️ Worker sem heartbeat há 12 min\nÚltimo ciclo às 10:02.\n👉 Reinicie o worker em Monitoramento.",
      evidence: { message: "…", autoResolve: true, lastHeartbeat: "2026-09-25T13:02:00.000Z", filas: ["closing.sync", "ia-judge"] },
    });
    expect(reading.summary).toBe("Worker sem heartbeat há 12 min");
    expect(reading.card).toEqual({ kind: "text", paragraphs: ["Último ciclo às 10:02."] });
    expect(reading.todo).toBe("Reinicie o worker em Monitoramento.");
    expect(reading.technical).toEqual([
      { label: "Last heartbeat", value: "25/09 10:02" },
      { label: "Filas", value: "closing.sync, ia-judge" },
    ]);
  });

  it("URL no meio do texto vira botão e some da frase", () => {
    expect(readActionText("Veja o post https://t.me/c/1/2 agora")).toEqual({
      lines: ["Veja o post agora"], todo: null,
      links: [{ label: "Abrir o post no Telegram", href: "https://t.me/c/1/2", external: true }],
    });
    expect(technicalFacts(null)).toEqual([]);
  });
});
