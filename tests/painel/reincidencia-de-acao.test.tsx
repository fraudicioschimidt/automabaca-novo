// @vitest-environment jsdom
import React, { act } from "react";
import { renderClickable } from "../helpers/click-render";
import { describe, expect, it } from "vitest";
import { contagemDaAcao, formaDoHistorico } from "@/app/_design/lib/reincidencia-de-acao";
import { ActionsCard } from "@/app/_design/screens/operacoes/actions-card";
import type { MonitoramentoData } from "@/app/_design/adapters/operacoes";
import { readAction } from "@/app/_design/lib/action-reading";

type Acao = MonitoramentoData["actions"][number];

/**
 * Ação encerrada que VOLTA não pode se disfarçar de ação nova.
 *
 * Se a reabertura em `reportOperationalActionWithExisting` reescrevesse
 * `openedAt = now()`, o campo que responde "desde quando este problema existe"
 * seria apagado justo quando a resposta importa, e o cartão publicaria
 *
 *     Alerta de infraestrutura · 40 ocorrências · desde há 17 h
 *
 * As duas metades não podem ser verdade juntas: um problema crônico ficaria mais
 * novo e menos grave a cada vez que voltasse — o oposto do que ele é.
 *
 * Três defesas, e cada uma reprova sozinha a regressão: o SERVIÇO preserva a
 * primeira vez e conta o retorno; o RASTRO grava a transição junto com a nota de
 * resolução que o update descarta; a TELA narra os contadores persistidos da
 * ação sem confundir idade da condição com idade do último ciclo.
 */

describe("o vocabulário do histórico", () => {
  it("sem retorno e com idade maior que a última ocorrência, diz 'desde'", () => {
    expect(formaDoHistorico({
      vezesQueVoltou: 0,
      desdeRelativo: "há 3 h",
      desdeAbsoluto: "13/06 10:10",
      ultimaVezRelativo: "há 30 min",
    })).toEqual({ forma: "desde", texto: "desde há 3 h" });
  });

  it("nasceu junto com a última ocorrência: cala, em vez de repetir", () => {
    expect(formaDoHistorico({
      vezesQueVoltou: 0,
      desdeRelativo: "há 38 min",
      desdeAbsoluto: "13/06 12:40",
      ultimaVezRelativo: "há 38 min",
    })).toEqual({ forma: "nada" });
  });

  /** A data é ABSOLUTA: "desde há 35 dias" faz o operador calcular. */
  it("com retorno, nomeia quantas vezes e desde quando", () => {
    expect(formaDoHistorico({
      vezesQueVoltou: 7,
      desdeRelativo: "há 35 d",
      desdeAbsoluto: "13/07 10:00",
      ultimaVezRelativo: "há 3 min",
    })).toEqual({
      forma: "reincidente",
      texto: "voltou 7 vezes desde 13/07 10:00",
      vezes: 7,
    });
  });

  it("concorda no singular — 'voltou 1 vezes' é o defeito", () => {
    const forma = formaDoHistorico({
      vezesQueVoltou: 1,
      desdeRelativo: "há 2 d",
      desdeAbsoluto: "15/08 08:00",
      ultimaVezRelativo: "agora",
    });
    expect(forma.forma).toBe("reincidente");
    expect(forma.forma === "reincidente" && forma.texto).toBe("voltou 1 vez desde 15/08 08:00");
  });

  it("a reincidência tem PRECEDÊNCIA sobre 'desde' — nunca as duas frases", () => {
    const forma = formaDoHistorico({
      vezesQueVoltou: 4,
      desdeRelativo: "há 9 d",
      desdeAbsoluto: "08/08 12:00",
      ultimaVezRelativo: "há 1 h",
    });
    expect(forma.forma === "reincidente" && forma.texto).not.toContain("desde há");
  });

  it("sem a data não afirma reincidência com número — cala, não inventa", () => {
    expect(formaDoHistorico({
      vezesQueVoltou: 3,
      desdeRelativo: "há 9 d",
      desdeAbsoluto: null,
      ultimaVezRelativo: "há 1 h",
    })).toEqual({ forma: "nada" });
  });

  it("entrada suja não vira reincidência fantasma", () => {
    for (const sujo of [null, undefined, Number.NaN, -3, 0.4]) {
      expect(formaDoHistorico({
        vezesQueVoltou: sujo,
        desdeRelativo: "há 9 d",
        desdeAbsoluto: "08/08 12:00",
        ultimaVezRelativo: "há 1 h",
      }).forma, String(sujo)).toBe("desde");
    }
  });
});

describe("o cartão normaliza os contadores da ação", () => {
  it("expõe ocorrências e retornos do próprio id", () => {
    expect(contagemDaAcao({ occurrences: 2, reopenCount: 7 }))
      .toEqual({ ocorrencias: 2, vezesQueVoltou: 7 });
  });

  it("campo ausente conta zero, nunca NaN na tela", () => {
    expect(contagemDaAcao({ occurrences: null, reopenCount: undefined }))
      .toEqual({ ocorrencias: 0, vezesQueVoltou: 0 });
  });
});

describe("a tela narra o que aconteceu", () => {
  const acaoBase = {
    id: "a1", area: "incidentes",
    title: "Alerta de infraestrutura", description: "Recurso saturado.",
    reading: readAction({ title: "Alerta de infraestrutura", description: "Recurso saturado.", actionType: "incident.review", evidence: null }),
    risk: "CRITICAL", status: "OPEN", owner: null, evidence: null,
    when: "17/08 19:06", whenRelativo: "há 3 min",
    resolutionNote: null, href: null,
  } satisfies Partial<Acao>;

  /** O histórico mora no corpo da linha: abre cada uma e junta o que ela narra. */
  const render = (acoes: Acao[]) => {
    const view = renderClickable(<ActionsCard actions={acoes} />);
    const linhas = [...view.container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")];
    const texto = linhas.map((linha) => {
      act(() => { linha.click(); });
      return view.container.textContent ?? "";
    }).join("\n");
    view.unmount();
    return { texto, linhas: linhas.map((linha) => linha.textContent ?? "") };
  };
  const html = (extra: Pick<Acao, "occurrences" | "reopenCount" | "desde" | "desdeAbsoluto">) => render([{ ...acaoBase, ...extra }]).texto;

  /** 40 ocorrências que não cabem em 17 horas. */
  it("crônico diz quantas vezes voltou e desde quando — não 'desde há 17 h'", () => {
    const saida = html({
      occurrences: 40, reopenCount: 7,
      desde: "há 17 h", desdeAbsoluto: "13/07 10:00",
    });
    expect(saida).toContain("40 ocorrências");
    expect(saida).toContain("voltou 7 vezes desde 13/07 10:00");
    expect(saida, "a idade do ciclo voltou a ser publicada como idade do problema")
      .not.toContain("desde há 17 h");
  });

  it("sem reincidência, a linha continua como era", () => {
    const saida = html({
      occurrences: 2, reopenCount: 0,
      desde: "há 2 h", desdeAbsoluto: "13/06 11:45",
    });
    expect(saida).toContain("desde há 2 h");
    expect(saida).not.toContain("voltou");
  });

  it("ações distintas com o mesmo texto continuam alcançáveis por id", () => {
    const saida = render([
      { ...acaoBase, id: "a1", occurrences: 10, reopenCount: 2, desde: "há 9 d", desdeAbsoluto: "08/08 12:00" },
      { ...acaoBase, id: "a2", occurrences: 4, reopenCount: 1, desde: "há 9 d", desdeAbsoluto: "08/08 12:00" },
      { ...acaoBase, id: "a3", occurrences: 1, reopenCount: 0, desde: "há 9 d", desdeAbsoluto: "08/08 12:00" },
    ]);
    expect(saida.linhas.filter((linha) => linha.includes("Alerta de infraestrutura"))).toHaveLength(3);
    expect(saida.texto).not.toContain("incidentes idênticos");
    expect(saida.texto).toContain("10 ocorrências");
    expect(saida.texto).toContain("4 ocorrências");
  });
});
