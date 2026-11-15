import React from "react";
import { describe, expect, it } from "vitest";
import { ReleasesCard } from "@/app/_design/screens/operacoes/releases-card";
import { MONITORAMENTO_MOCK } from "@/app/_design/mock/operacoes";
import { renderDesignMarkup } from "../helpers/design-markup";

type ReleaseView = (typeof MONITORAMENTO_MOCK.releases)[number];

const JUDGED: ReleaseView = {
  id: "auto-aac63af-20260613-aac63af", sha: "aac63af", at: "13/06 10:21", ago: "há 3 h", state: "sem_erro_novo",
  verdictFrom: "11:06", commitUrl: "https://github.com/x/y/commit/aac63af", compareUrl: null,
  knownErrors: 0, notice: null, findings: [], belowThreshold: [],
};

const render = (releases: ReleaseView[]) => renderDesignMarkup(<ReleasesCard releases={releases} />);

describe("card das releases no Monitoramento", () => {
  it("diz o estado de cada release em texto, com o erro novo e os links", () => {
    const html = render(MONITORAMENTO_MOCK.releases);
    // A cor não é o único portador do veredito.
    for (const label of ["Em observação", "Erro novo", "Sem erro novo", "Sem veredito"]) expect(html).toContain(label);
    expect(html).toContain("1 com erro novo");
    expect(html).toContain("Veredito a partir de 13:25");
    expect(html).toContain("TypeError: Cannot read properties of undefined (reading &#x27;odds&#x27;)");
    expect(html).toContain("7× em 2 jobs · desde 11:06");
    expect(html).toContain("4 falhas de erros já conhecidos");
    expect(html).toContain("Aviso enviado no Telegram.");
    expect(html).toContain("o worker ficou parado ou o job ops.release_verdict falhou");
    expect(html).toContain("não prova que a release é a causa");
    expect(html).toMatch(/href="https:\/\/github\.com\/[^"]+\/compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}" target="_blank" rel="noopener noreferrer"/);
    // Sem release anterior conhecida, só o commit.
    expect(html.match(/Mudanças desde a anterior/g)).toHaveLength(2);
  });

  it("o erro novo abaixo do mínimo aparece com as tentativas, em vez de um zero", () => {
    const html = render([{
      ...JUDGED,
      belowThreshold: [
        { id: "a", queue: "closing.price_series", text: "TypeError: x is not a function", occurrences: 2, jobs: 2, firstAt: "10:40" },
      ],
    }]);
    expect(html).toContain("Nenhum erro novo chegou a 3 tentativas.");
    expect(html).toContain("2 tentativas de um erro novo, abaixo do mínimo de 3: não virou aviso e passa a contar como conhecido.");
    expect(html).toContain("closing.price_series</span> — TypeError: x is not a function");
    expect(html).not.toContain("Nenhum erro atribuível");
  });

  it("sem erro nenhum, não afirma que nenhuma fila falhou: só que nada é atribuível à release", () => {
    const html = render([JUDGED]);
    expect(html).toContain("Nenhum erro atribuível à release nos 45 min de observação.");
    expect(html).not.toContain("Nenhuma falha de fila");
    expect(html).toContain("Fornecedor fora, circuito aberto e o worker saindo no deploy não contam.");
  });

  it("o aviso que não saiu diz se o job ainda tenta ou se desistiu", () => {
    const flagged: ReleaseView = {
      ...JUDGED,
      state: "erro_novo",
      findings: [{ id: "a", queue: "sharp.enrich", text: "TypeError: boom", occurrences: 3, jobs: 1, firstAt: "10:30" }],
    };
    expect(render([{ ...flagged, notice: "retrying" }])).toContain("o job tenta de novo por 24 h depois do veredito");
    expect(render([{ ...flagged, notice: "gave_up" }])).toContain("não saiu nas 24 h de tentativas; o veredito fica só aqui");
  });

  it("sem release registrada, diz quando a primeira aparece em vez de uma lista vazia", () => {
    const html = render([]);
    expect(html).toContain("Nenhuma release registrada");
    expect(html).not.toContain("últimas");
  });
});
