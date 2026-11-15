import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ATALHOS_GERAIS,
  ATALHOS_POR_TELA,
  FAIXA_DE_CANDIDATOS,
  TECLA_MATCHING,
  NAV,
  TECLA_PALETA,
} from "@/app/_design/lib/atalhos";
import { FolhaDeAtalhos } from "@/app/(painel)/FolhaDeAtalhos";

/**
 * Atalho que existe e a folha do `?` não anuncia.
 *
 * A folha promete "Ver esta lista", então tem de trazer também os atalhos de
 * tela (o `1–9` e o `I` do Vincular), não só os globais. Lista divergente do
 * atalho real ensina o gesto errado; atalho FORA da lista é pior de perceber:
 * nada na tela está errado, só falta — e o operador conclui que o recurso não
 * existe.
 */

const folha = renderToStaticMarkup(<FolhaDeAtalhos />);

describe("a folha do ? anuncia todo atalho do registro", () => {
  it.each(ATALHOS_GERAIS.map((a) => [a.descricao, a.teclas] as const))(
    "geral: %s",
    (descricao, teclas) => {
      expect(folha).toContain(descricao);
      for (const tecla of teclas) expect(folha).toContain(tecla);
    },
  );

  it.each(
    ATALHOS_POR_TELA.flatMap((g) => g.entradas.map((a) => [g.escopo, a.descricao, a.teclas] as const)),
  )("%s: %s", (escopo, descricao, teclas) => {
    expect(folha).toContain(escopo);
    expect(folha).toContain(descricao);
    for (const tecla of teclas) expect(folha).toContain(tecla);
  });

  it("o Vincular aparece — foi o atalho que existia e a folha não conhecia", () => {
    expect(folha).toContain(FAIXA_DE_CANDIDATOS);
    expect(folha).toContain(TECLA_MATCHING.ignorar.toUpperCase());
    expect(folha).toContain("Operações · Vincular");
  });

  it("os destinos de navegação continuam na folha, com o atalho de cada um", () => {
    for (const item of NAV) {
      expect(folha).toContain(item.title);
      expect(folha).toContain(item.shortcut);
    }
  });

  /**
   * O rótulo "G D" e o `keySequence` do handler são escritos em lugares
   * diferentes. Se o prefixo divergir, a tela ensina um gesto que o handler não
   * escuta — e nada quebra, o atalho só não funciona.
   */
  it("todo atalho de navegação começa pelo prefixo que o handler espera", () => {
    const prefixo = TECLA_PALETA.navegar.toUpperCase();
    const fora = NAV.filter((item) => !item.shortcut.startsWith(`${prefixo} `));
    expect(fora.map((i) => `${i.title}: ${i.shortcut}`)).toEqual([]);
  });
});
