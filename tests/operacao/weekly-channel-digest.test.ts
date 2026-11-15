import { describe, expect, it } from "vitest";
import type { DecisaoCanal } from "@/src/domain/analyzer/decisao";
import type { ChannelDecision } from "@/src/services/bankrolls/channel-decision";
import { DIGEST_MAX_CHARS } from "@/src/services/ops/digests/pending-digest";
import { buildWeeklyChannelDigest } from "@/src/services/ops/digests/weekly-channel-digest";

/** Segunda, 21/09/2026, 09:00 em São Paulo. */
const NOW = new Date("2026-09-21T12:00:00Z");

function channel(id: string, decisao: Partial<DecisaoCanal>, over: Partial<ChannelDecision> = {}): ChannelDecision {
  return {
    id,
    nome: `Canal ${id}`,
    slug: `canal-${id}`,
    sharpMode: "CLV_ONLY",
    temCanal: true,
    decisao: {
      apostas: 0,
      nClv: 0,
      beatClosePct: null,
      clvMedio: null,
      distClv: [],
      nFinal: 0,
      roiReal: null,
      clv30d: null,
      n30d: 0,
      n30a60d: 0,
      deltaClv30d: null,
      veredito: "AMOSTRA_CURTA",
      tStat: null,
      ...decisao,
    },
    ...over,
  };
}

describe("buildWeeklyChannelDigest", () => {
  it("lista na ordem da régua de Bancas, com a amostra de cada número, e a semana é agora menos 7 dias atrás", () => {
    const current = [
      channel("curta", { apostas: 12, nClv: 12, clvMedio: 8, beatClosePct: 75, nFinal: 10, roiReal: -3 }),
      channel("forte", {
        apostas: 150, nClv: 142, clvMedio: 3.1, beatClosePct: 58.4, nFinal: 130, roiReal: 4.2, veredito: "EDGE", tStat: 3.2,
      }),
    ];
    const weekAgo = [
      channel("curta", { apostas: 8, nClv: 12, clvMedio: 8 }),
      // 130 fechamentos a +3.1 antes, 12 na semana: a média de agora, 3.1, fica com 3.1 na semana.
      channel("forte", { apostas: 138, nClv: 130, clvMedio: 3.1, veredito: "EDGE", tStat: 3 }),
    ];

    const digest = buildWeeklyChannelDigest(current, weekAgo, NOW);

    expect(digest).toEqual({ channels: 2, verdictChanges: 0, message: [
      "📊 Boletim semanal dos canais · 7 dias até 21/09 09:00",
      "",
      "📋 Canais com movimento, na ordem de Tipsters",
      "1. Canal forte · Manter",
      "• CLV +3.1% (n 142) · beat-close 58% · ROI +4.2% (n 130)",
      "• Na semana: 12 apostas · CLV +3.1% (n 12)",
      "2. Canal curta · Amostra curta",
      "• CLV +8.0% (n 12 de 30) · beat-close 75% · ROI -3.0% (n 10)",
      "• Na semana: 4 apostas · nenhum fechamento",
    ].join("\n") });
  });

  it("o CLV da semana é o dos fechamentos novos, não a média acumulada", () => {
    const digest = buildWeeklyChannelDigest(
      [channel("a", { apostas: 40, nClv: 40, clvMedio: 2 })],
      [channel("a", { apostas: 30, nClv: 30, clvMedio: 4 })],
      NOW,
    );
    // 40 × 2 − 30 × 4 = −40 em 10 fechamentos novos.
    expect(digest.message).toContain("• Na semana: 10 apostas · CLV -4.0% (n 10)");
  });

  it("semana sem aposta de canal não manda nada, mesmo com a banca manual apostando", () => {
    const current = [
      channel("parado", { apostas: 50, nClv: 45, clvMedio: 2 }),
      channel("manual", { apostas: 9 }, { temCanal: false }),
    ];
    const weekAgo = [
      channel("parado", { apostas: 50, nClv: 45, clvMedio: 2 }),
      channel("manual", { apostas: 1 }, { temCanal: false }),
    ];
    expect(buildWeeklyChannelDigest(current, weekAgo, NOW)).toEqual({ message: null, channels: 0, verdictChanges: 0 });
  });

  it("entra o canal que só teve fechamento na semana; o parado e a banca sem canal ficam de fora", () => {
    const current = [
      channel("ativo", { apostas: 3 }),
      channel("so-fechou", { apostas: 20, nClv: 20, clvMedio: 1 }),
      channel("parado", { apostas: 7, nClv: 7, clvMedio: 1 }),
      channel("manual", { apostas: 5 }, { temCanal: false }),
    ];
    const weekAgo = [
      channel("ativo", {}),
      channel("so-fechou", { apostas: 20, nClv: 18, clvMedio: 1 }),
      channel("parado", { apostas: 7, nClv: 7, clvMedio: 1 }),
      channel("manual", { apostas: 1 }, { temCanal: false }),
    ];
    const message = buildWeeklyChannelDigest(current, weekAgo, NOW).message ?? "";
    expect(message).toContain("Canal ativo");
    expect(message).toContain("Canal so-fechou · Amostra curta\n• CLV +1.0% (n 20 de 30)\n• Na semana: 0 apostas · CLV +1.0% (n 2)");
    expect(message).not.toContain("Canal parado");
    expect(message).not.toContain("Canal manual");
  });

  it("destaca a troca de veredito só com 20 fechamentos em cada uma das duas janelas de 30 dias", () => {
    const decaindo = { apostas: 90, nClv: 80, clvMedio: 1.2, veredito: "INCONCLUSIVO", n30d: 24, n30a60d: 31, deltaClv30d: -2.64 } as const;
    const semBase = { apostas: 60, nClv: 55, clvMedio: 4, veredito: "EDGE", n30d: 25, n30a60d: 12, deltaClv30d: 1 } as const;
    const current = [channel("decaindo", decaindo), channel("sem-base", semBase)];
    const weekAgo = [
      channel("decaindo", { apostas: 80, nClv: 70, clvMedio: 2, veredito: "EDGE" }),
      channel("sem-base", { apostas: 50, nClv: 45, clvMedio: 3, veredito: "INCONCLUSIVO" }),
    ];

    const digest = buildWeeklyChannelDigest(current, weekAgo, NOW);

    expect(digest.verdictChanges).toBe(1);
    expect(digest.message).toContain("🔀 Mudou de veredito\n⬇️ Canal decaindo: Manter → Monitorar · Δ 30d -2.6 p.p. (n 24/31)\n\n");
    expect(digest.message).not.toContain("⬆️");
    // Sem destaque, o veredito novo continua na lista.
    expect(digest.message).toContain("1. Canal sem-base · Manter");
    expect(digest.message).not.toContain("Config › Tipsters");
  });

  it("a troca para Pausar lembra que a pausa guarda o histórico; a que melhora sobe", () => {
    const base = { n30d: 30, n30a60d: 40, deltaClv30d: -4 };
    const digest = buildWeeklyChannelDigest(
      [
        channel("caiu", { ...base, apostas: 100, nClv: 90, clvMedio: -3, veredito: "SEM_EDGE" }),
        channel("subiu", { ...base, deltaClv30d: 2, apostas: 100, nClv: 90, clvMedio: 3, veredito: "EDGE" }),
      ],
      [
        channel("caiu", { apostas: 90, nClv: 80, clvMedio: -1, veredito: "INCONCLUSIVO" }),
        channel("subiu", { apostas: 90, nClv: 80, clvMedio: 2, veredito: "INCONCLUSIVO" }),
      ],
      NOW,
    );
    expect(digest.message).toContain([
      "🔀 Mudou de veredito",
      "⬆️ Canal subiu: Monitorar → Manter · Δ 30d +2.0 p.p. (n 30/40)",
      "⬇️ Canal caiu: Monitorar → Pausar · Δ 30d -4.0 p.p. (n 30/40)",
      "👉 Para parar um canal sem perder o histórico de CLV, pause-o em Config › Tipsters.",
    ].join("\n"));
  });

  it("passando de 15 canais, lista os primeiros da régua e diz quantos faltam", () => {
    const ids = Array.from({ length: 17 }, (_, index) => `c${String(index).padStart(2, "0")}`);
    const digest = buildWeeklyChannelDigest(
      ids.map((id, index) => channel(id, { apostas: 1, nClv: 1, clvMedio: 20 - index })),
      ids.map((id) => channel(id, {})),
      NOW,
    );
    expect(digest.channels).toBe(17);
    expect(digest.message).toContain("15. Canal c14 ·");
    expect(digest.message).not.toContain("Canal c15");
    expect(digest.message?.endsWith("… e mais 2 canais; veja Tipsters no painel.")).toBe(true);
  });

  it("com nomes longos, lista só os canais que cabem numa mensagem, e a linha dos que faltam chega inteira", () => {
    const ids = Array.from({ length: 15 }, (_, index) => `c${String(index).padStart(2, "0")}`);
    // 128 caracteres, o máximo do nome do canal.
    const longName = (id: string) => `Canal ${id} ${"x".repeat(118)}`;
    const flipped = { apostas: 1234, nClv: 25, beatClosePct: 60, nFinal: 1200, roiReal: -12.5, veredito: "SEM_EDGE", n30d: 25, n30a60d: 40, deltaClv30d: -12.5 } as const;
    const digest = buildWeeklyChannelDigest(
      ids.map((id, index) => channel(id, { ...flipped, clvMedio: -index }, { nome: longName(id) })),
      ids.map((id) => channel(id, { veredito: "INCONCLUSIVO" })),
      NOW,
    );

    const message = digest.message ?? "";
    const listed = message.split("\n").filter((line) => /^\d+\. Canal/.test(line)).length;
    expect(listed).toBeGreaterThan(0);
    expect(message.endsWith(`\n… e mais ${15 - listed} canais; veja Tipsters no painel.`)).toBe(true);
    // Cabe sem o corte da última trava, que levaria essa linha.
    expect(Array.from(message).length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
  });
});
