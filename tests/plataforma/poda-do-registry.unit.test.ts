import { describe, it, expect } from "vitest";
import { ARTEFATOS_DE_RELEASE_MANTIDOS, MANTER, versoesParaApagar } from "@/scripts/podar-versoes-do-registry.mjs";

const versao = (id: number, diasAtras: number, tags: string[] = [`commit-${id}`]) => ({
  id,
  created_at: new Date(Date.now() - diasAtras * 86_400_000).toISOString(),
  metadata: { container: { tags } },
});

/** Um push de verdade: manifest e atestado sem etiqueta, índice etiquetado por último. */
const publicacao = (base: number, horasAtras: number) => {
  const em = (minutosAntes: number) => new Date(Date.now() - horasAtras * 3_600_000 - minutosAntes * 60_000).toISOString();
  return [
    { id: base + 1, created_at: em(4), metadata: { container: { tags: [] } } },
    { id: base + 2, created_at: em(3), metadata: { container: { tags: [] } } },
    { id: base, created_at: em(0), metadata: { container: { tags: [`commit-${base}`] } } },
  ];
};

describe("Poda de versões no registry", () => {
  it("mantém as mais recentes e apaga o resto", () => {
    const versoes = [versao(1, 0), versao(2, 1), versao(3, 2), versao(4, 3), versao(5, 4)];
    expect(versoesParaApagar(versoes, { manter: 3 })).toEqual([4, 5]);
  });

  /**
   * O limite aqui é ESPAÇO, não idade. Dez releases num dia estouram a cota com
   * tudo recente. Uma regra por idade não protegeria; o teto duro protege.
   */
  it("apaga mesmo quando tudo é recente", () => {
    const hoje = Array.from({ length: 10 }, (_, i) => versao(i + 1, 0));
    expect(versoesParaApagar(hoje, { manter: 3 })).toHaveLength(7);
  });

  it("não apaga nada quando há menos que o mínimo", () => {
    expect(versoesParaApagar([versao(1, 0), versao(2, 5)], { manter: 3 })).toEqual([]);
  });

  /**
   * Contando versões soltas, `manter: 2` apagaria o manifest da imagem mais
   * nova e deixaria o índice apontando para o nada.
   */
  it("mantém publicações inteiras, com os pedaços sem etiqueta", () => {
    const versoes = [...publicacao(300, 0), ...publicacao(200, 5), ...publicacao(100, 30)];
    expect(versoesParaApagar(versoes, { manter: 2 }).sort()).toEqual([100, 101, 102]);
  });

  it("apaga pedaço sem etiqueta que sobrou de publicação antiga", () => {
    const orfao = { id: 9, created_at: new Date(Date.now() - 48 * 3_600_000).toISOString(), metadata: { container: { tags: [] } } };
    expect(versoesParaApagar([...publicacao(300, 0), orfao], { manter: 1 })).toEqual([9]);
  });

  it("sem nenhuma versão etiquetada, não apaga nada", () => {
    expect(versoesParaApagar([versao(1, 0, []), versao(2, 9, [])], { manter: 1 })).toEqual([]);
  });

  it("ordena por data, não pela ordem de chegada da API", () => {
    const fora = [versao(10, 9), versao(20, 0), versao(30, 4)];
    expect(versoesParaApagar(fora, { manter: 1 })).toEqual([30, 10]);
  });

  it("imagens e artefatos, juntos, cabem nos 2 GB do plano", () => {
    // Pacotes e artefatos dividem a mesma cota: somar só as imagens deixa os
    // artefatos acumulados travarem a CI.
    // ~250 MB por imagem × 2 imagens × MANTER, mais ~80 MB por artefato de
    // release, e ainda uma versão nova subindo antes de a antiga sair.
    const imagens = MANTER * 2 * 250;
    const artefatos = ARTEFATOS_DE_RELEASE_MANTIDOS * 80;
    const versaoSubindo = 2 * 250;
    expect(imagens + artefatos + versaoSubindo).toBeLessThan(2048);
  });
});
