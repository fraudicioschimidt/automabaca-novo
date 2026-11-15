import { describe, expect, it } from "vitest";
import { Prisma } from "@/src/generated/prisma/browser";
import { AUTORIA_DO_TRABALHO, type AutoriaDeTrabalho } from "@/src/domain/rendimento-de-provider";

/**
 * O rendimento por provider conta o trabalho pelas colunas de autoria de
 * BetSharp, BetClosing e BetResult. Coluna de provider nova nessas tabelas que
 * não for classificada some da contagem sem aviso; este teste obriga a decisão.
 */
const COLUNAS: Record<AutoriaDeTrabalho["modelo"], readonly string[]> = {
  BetSharp: Object.values(Prisma.BetSharpScalarFieldEnum),
  BetClosing: Object.values(Prisma.BetClosingScalarFieldEnum),
  BetResult: Object.values(Prisma.BetResultScalarFieldEnum),
};

/** Colunas com "provider" no nome que NÃO registram quem entregou o trabalho. */
const NAO_SAO_AUTORIA: Record<AutoriaDeTrabalho["modelo"], Readonly<Record<string, string>>> = {
  BetSharp: {
    // Id do evento no namespace do provider que resolveu: identificador, não autoria.
    providerMatchId: "identificador",
  },
  BetClosing: {},
  BetResult: {},
};

const pareceProvider = (coluna: string) => /provider/i.test(coluna);

describe("autoria do trabalho de provider", () => {
  const autorias = Object.values(AUTORIA_DO_TRABALHO);

  it.each(Object.keys(COLUNAS) as AutoriaDeTrabalho["modelo"][])("toda coluna de provider em %s está classificada", (modelo) => {
    const classificadas = new Set([
      ...autorias.filter((a) => a.modelo === modelo).map((a) => a.autoria),
      ...Object.keys(NAO_SAO_AUTORIA[modelo]),
    ]);
    const semClassificacao = COLUNAS[modelo].filter(pareceProvider).filter((coluna) => !classificadas.has(coluna));
    expect(semClassificacao, "classifique em AUTORIA_DO_TRABALHO ou em NAO_SAO_AUTORIA").toEqual([]);
  });

  it("as colunas de autoria e de instante existem no schema", () => {
    for (const { modelo, autoria, instante } of autorias) {
      expect(COLUNAS[modelo]).toContain(autoria);
      expect(COLUNAS[modelo]).toContain(instante);
    }
  });

  it("as exceções apontam para colunas que existem e não são autoria", () => {
    for (const [modelo, excecoes] of Object.entries(NAO_SAO_AUTORIA) as [AutoriaDeTrabalho["modelo"], Record<string, string>][]) {
      for (const coluna of Object.keys(excecoes)) {
        expect(COLUNAS[modelo]).toContain(coluna);
        expect(autorias.some((a) => a.modelo === modelo && a.autoria === coluna)).toBe(false);
      }
    }
  });
});
