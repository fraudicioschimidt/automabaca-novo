import { renderDesignMarkup } from "../helpers/design-markup";
import { describe, expect, it } from "vitest";
import {
  ChannelsCard,
  transientRetryFeedback,
} from "@/app/_design/screens/operacoes/channels-card";
import type { MonitoramentoData } from "@/app/_design/adapters/operacoes";

type Canal = MonitoramentoData["channels"][number];

function channel(overrides: Partial<Canal> = {}): Canal {
  return {
    id: "canal-1",
    name: "Canal",
    tg: "-1001",
    state: "degraded",
    parse: 40,
    total: 125,
    ok: 5,
    parseFailureTotal: 120,
    parseDescartadas: 3,
    captures: 125,
    last: "agora",
    parsePerdas: [
      { motivo: "odd_legenda_ausente", rotulo: "legenda sem a odd", classe: "legenda_incompleta", proximaEtapa: "a odd decide o lucro", n: 40 },
    ],
    identity: 80,
    identityResolved: 8,
    identityPending: 1,
    identityFailed: 1,
    noOdds: [],
    resolutionP50: "5 min",
    resolutionP95: "20 min",
    resolutionSamples: 8,
    preKickoffFailures: 0,
    transientFailures: 240,
    transientBatchLimit: 100,
    discardedTotal: 0,
    discarded: [],
    orphan: false,
    lastUpdate: "há 3 min",
    silence: null,
    latencyP50: "2 min",
    latencyP95: "6 min",
    latencySamples: 5,
    ...overrides,
  };
}

describe("ChannelsCard", () => {
  it("explicita os escopos temporais diferentes das métricas", () => {
    const html = renderDesignMarkup(
      <ChannelsCard channels={[]} onRetryTransient={undefined} />,
    );

    expect(html).toContain(
      "Parse e resolução · 30 dias; capturas, identidade e odds · histórico",
    );
    expect(html).not.toContain("Parse, identidade, odds e resolução · janela de 30 dias");
  });

  it("mostra a causa exata, o descarte correto e a capacidade do lote", () => {
    const html = renderDesignMarkup(
      <ChannelsCard channels={[channel()]} onRetryTransient={async () => ({
        ok: true as const,
        totalElegiveis: 240,
        elegiveis: 100,
        enfileiradas: 90,
        puladas: 10,
      })} />,
    );

    // A causa é a contagem EXATA, não uma amostra dos mais recentes, com o
    // rótulo do vocabulário único (`domain/recusa-de-captura`).
    expect(html).toContain("Causas de parse:");
    expect(html).toContain("legenda sem a odd (40)");
    expect(html).not.toContain("mais recentes de");
    // Descarte correto aparece, mas FORA da conta de falha.
    expect(html).toContain("3 não eram aposta (fora da conta)");
    expect(html).toContain("Reprocessar até 100 de 240");
    expect(html).toContain("apostas já na fila não são duplicadas");
  });

  it("falta de odds sai com o rótulo do vocabulário, não o código gravado", () => {
    const html = renderDesignMarkup(<ChannelsCard channels={[channel({
      noOdds: [{ reason: "kickoff_sem_captura", label: "kickoff sem captura de closing", n: 4 }],
    })]} />);
    expect(html).toContain("Sem odds:");
    expect(html).toContain("kickoff sem captura de closing (4)");
    expect(html).not.toContain("kickoff_sem_captura");
  });

  it("separa canal calado de captura falhando: último update, selo e tempo até a captura", () => {
    const muted = renderDesignMarkup(<ChannelsCard channels={[channel({
      lastUpdate: "há 9 h", silence: { kind: "mudo", detail: "calado há 9.0 h; o normal é até 6.0 h" },
      latencyP50: "3 min", latencyP95: "22 min", latencySamples: 14,
    })]} />);
    expect(muted).toContain("último update há 9 h");
    expect(muted).toContain(">mudo</span>");
    expect(muted).toContain("Canal calado há 9.0 h; o normal é até 6.0 h.");
    expect(muted).toContain("Post → captura p50");
    expect(muted).toContain("p95 22 min · n=14");

    const learning = renderDesignMarkup(<ChannelsCard channels={[channel({ lastUpdate: null, silence: { kind: "aprendendo", detail: "ainda aprendendo o ritmo do canal" } })]} />);
    expect(learning).toContain("último update nenhum registrado");
    expect(learning).toContain(">aprendendo</span>");
    expect(learning).not.toContain("Canal calado");
  });

  it("mostra o texto dos posts que não viraram aposta e o botão de captura para quem opera", () => {
    const discarded = {
      discardedTotal: 6,
      discarded: [
        { messageId: 43, photo: true, text: "Over 150.5 pontos", reason: "captura do canal pausada", postedAt: "13/06 09:20", age: "há 32 min", stale: false, captureRequestedAt: null, link: null },
        { messageId: 42, photo: false, text: "Flamengo x Palmeiras\nAmbas marcam sim", reason: "não parecia aposta", postedAt: "13/06 09:12", age: "há 40 min", stale: false, captureRequestedAt: null, link: "https://t.me/c/1/42" },
        { messageId: 41, photo: false, text: "Resultado do dia ✅", reason: "resultado ou balanço", postedAt: "13/06 08:02", age: "há 5 h", stale: true, captureRequestedAt: "13/06 09:40", link: null },
      ],
    };
    const html = renderDesignMarkup(
      <ChannelsCard channels={[channel(discarded)]} onCaptureDiscarded={async () => ({ ok: true as const, status: "enfileirado" as const })} />,
    );
    expect(html).toContain("6 posts que não viraram aposta");
    expect(html).toContain("Foto 43 · 13/06 09:20 (há 32 min) · captura do canal pausada");
    expect(html).toContain("13/06 08:02 (há 5 h) · resultado ou balanço");
    // Só o post velho avisa que o jogo pode ter terminado.
    expect(html.match(/o jogo pode ter terminado/g)).toHaveLength(1);
    expect(html).toContain("Exibindo os 3 mais recentes.");
    expect(html).toContain("Ambas marcam sim");
    expect(html).toContain("Capturar mesmo assim");
    expect(html).toContain("captura pedida em 13/06 09:40");
    expect(html).toContain("Pedir de novo");
    expect(html).toContain('href="https://t.me/c/1/42"');

    const readOnly = renderDesignMarkup(<ChannelsCard channels={[channel(discarded)]} />);
    expect(readOnly).toContain("Ambas marcam sim");
    expect(readOnly).not.toContain("Capturar mesmo assim");
    expect(renderDesignMarkup(<ChannelsCard channels={[channel()]} />)).not.toContain("viraram aposta");
  });

  it("explica itens pulados e fora do lote no feedback", () => {
    expect(transientRetryFeedback({
      ok: true,
      totalElegiveis: 240,
      elegiveis: 100,
      enfileiradas: 90,
      puladas: 10,
    })).toBe(
      "90 falhas transitórias reenfileiradas · 10 já estavam na fila · 140 ficaram fora deste lote",
    );
  });

  it("distingue o total de canais órfãos da janela visível", () => {
    const orphanChannels = Array.from({ length: 20 }, (_, index) => ({
      id: `orphan-${index}`,
      name: "Sem banca",
      tg: `-${index}`,
      parse: 0,
      total: 0,
      ok: 0,
      captures: 1,
      last: "agora",
      orphan: true,
    }));
    const html = renderDesignMarkup(
      <ChannelsCard
        channels={[]}
        orphanChannels={orphanChannels}
        orphanChannelsTotal={24}
        onRetryTransient={undefined}
      />,
    );

    expect(html).toContain("24 canais sem tipster mapeado");
    expect(html).toContain("Exibindo os 20 mais recentes.");
  });
});
