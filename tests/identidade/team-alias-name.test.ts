import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalizeTeamName } from "@/src/domain/text";
import { nationalTeamCountry, teamAliasNameProblem, type TeamAliasNameProblem } from "@/src/domain/team-alias-name";

/**
 * O filtro decide se um texto pode ser GRAVADO como alias de um clube e se
 * TRADUZ. As propriedades cobrem o que a auditoria revogou (vaga, dois times,
 * a seleção da aposta, nome cortado, genérico sem contexto, país levando a
 * clube) e o que não pode ser barrado (grafias reais com conector, barra,
 * sigla, país dentro do nome do clube, nome genérico do provider ou do dono),
 * sob caixa, acentos e espaços variados, e texto arbitrário.
 */

const PROPERTY_CONFIG = { numRuns: 300 } as const;

const PROBLEMS: readonly TeamAliasNameProblem[] = [
  "empty", "placeholder", "fixture", "ellipsis", "market", "generic", "country",
];

/** Clubes reais sem nenhum problema de nome. */
const CLUBES = [
  "Flamengo", "Palmeiras", "Bragantino", "Atlético-GO", "Vitória SC", "1. FC Union Berlin",
  "Casa Pia", "Seoul E-Land", "Hull City", "Ponte Preta", "Operario-PR", "Gimnasia y Esgrima",
  "Schalke 04", "St. Pauli", "Man City", "PSG", "Real Madrid", "Universidad de Chile",
  "Petrin Plzen", "Busan IPark", "South China", "Qatar SC", "Gol Gohar", "U Craiova",
  "Odd", "Odds BK", "Odd Grenland", "Total Network Solutions",
] as const;

/**
 * Grafias reais que um filtro ingênuo recusaria: conector ou barra dentro do
 * nome do próprio clube, sigla, país dentro do nome, palavra que também é de
 * mercado. Cada uma leva ao clube que ela nomeia.
 */
const GRAFIAS_REAIS: ReadonlyArray<readonly [string, string]> = [
  ...CLUBES.map((nome) => [nome, nome] as const),
  ["Brighton & Hove Albion", "Brighton and Hove Albion"], ["Trinidad and Tobago", "Trinidad & Tobago"],
  ["Bosnia and Herzegovina", "Bosnia-Herzegovina"], ["São Tomé e Príncipe", "Sao Tome and Principe"],
  ["Bodo/Glimt", "Bodø/Glimt"], ["Trygg/Lade", "Trygg/Lade"], ["Ull/Kisa", "Ull/Kisa"],
  ["Atlético/GO", "Atletico Goianiense"], ["Botafogo/PB", "Botafogo PB"],
  ["AZ", "AZ Alkmaar"], ["FH", "FH Hafnarfjordur"], ["KR", "KR Reykjavik"],
  ["Real España", "Real Espana"], ["Uruguay de Coronado", "Uruguay de Coronado"],
  ["Brasil de Pelotas", "Brasil de Pelotas"], ["Internacional", "Internacional"],
  ["New England", "New England Revolution"], ["Nes Ziona", "Ironi Ness Ziona"], ["Lusitania FC", "Lusitania Lourosa"],
];

const VAGAS = [
  "desconhecido", "Desconhecida", "unknown", "Unknown Team", "TBD", "tba", "A definir", "Por definir",
  "a confirmar", "Time 1", "Time A", "Team B", "Equipe 2", "Casa", "Fora", "Mandante", "Visitante",
  "Home Team", "Away", "Time da casa", "Vencedor Jogo 3", "Winner QF1", "Perdedor da semi",
] as const;

const GENERICOS = [
  "Sporting", "Wanderers", "Estudiantes", "Real", "Atlético", "Nacional", "United", "City", "Racing Club",
  "Inter", "Club America", "D.C. United", "Universitario de Deportes", "Athletic Club", "Rangers",
] as const;

/** País como nome inteiro, e a seleção a que ele pode levar. */
const PAISES: ReadonlyArray<readonly [string, string]> = [
  ["China", "China PR"], ["Brasil", "Brazil"], ["Brazil", "Brazil U20"], ["França", "France"],
  ["Argentina", "Argentina Women"], ["Chile", "Chile"], ["Estados Unidos", "USA"], ["Qatar", "Qatar"],
  ["Coreia do Sul", "South Korea"], ["Holanda", "Netherlands"],
];

const semAcento = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "");

/** O mesmo nome como tipster e provider costumam escrever: caixa, acento e espaços. */
function grafia(name: string): fc.Arbitrary<string> {
  return fc.tuple(
    fc.constantFrom<(text: string) => string>(
      (text) => text,
      (text) => text.toUpperCase(),
      (text) => text.toLowerCase(),
      semAcento,
    ),
    fc.integer({ min: 1, max: 3 }),
    fc.boolean(),
  ).map(([caixa, espacos, borda]) => {
    const texto = caixa(name).replace(/ /g, " ".repeat(espacos));
    return borda ? `  ${texto} ` : texto;
  });
}

const tokens = (name: string) => canonicalizeTeamName(name).split(" ").filter(Boolean);

/** A mesma palavra, ou uma prefixo da outra com 3 letras ou mais ("Bodo" × "Bodø", que vira "bod"). */
const mesmaPalavra = (a: string, b: string) =>
  a === b || (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)));

/** Dois clubes diferentes, sem palavra em comum: juntos, são dois times. */
const doisClubes = fc.tuple(fc.constantFrom(...CLUBES), fc.constantFrom(...CLUBES))
  .filter(([casa, fora]) => !tokens(fora).some((token) => tokens(casa).some((outro) => mesmaPalavra(token, outro))))
  .chain(([casa, fora]) => fc.tuple(grafia(casa), grafia(fora), fc.constant(casa)));

const clube = fc.constantFrom(...CLUBES).chain(grafia);

/** Qualquer contexto: vazio, só país, região, competição genérica ou completo. */
const escopo = fc.record({
  country: fc.constantFrom("", "Brazil", "Argentina", "World", "Europe", "Portugal"),
  competition: fc.constantFrom("", "Serie A", "Liga Profesional", "Cup", "Liga", "Primeira Liga"),
});

/** Quem escreveu e a origem do alias: as regras de texto que não nomeia clube valem para todos. */
const autoria = fc.record({
  author: fc.constantFrom("tipster" as const, "provider" as const),
  source: fc.constantFrom("AUTO", "LLM", "MANUAL", "PROMOTED", undefined),
});

describe("o que a auditoria revogou não vira alias", () => {
  it.each([
    ["desconhecido", "placeholder"],
    ["unknown", "placeholder"],
    ["Grêmio & Flamengo vs Bragantino", "fixture"],
    ["atletico go and nautico vs sport", "fixture"],
    ["Deportes...", "ellipsis"],
    ["Sporting", "generic"],
    ["Wanderers", "generic"],
    ["Estudiantes", "generic"],
  ] as const)("%s → %s", (nome, motivo) => {
    expect(teamAliasNameProblem(nome, { target: "Flamengo", author: "tipster" })).toBe(motivo);
  });

  it("nome de país levando a um clube: China não é o South China", () => {
    expect(teamAliasNameProblem("China", { target: "South China", author: "provider" })).toBe("country");
    expect(teamAliasNameProblem("China", { target: "China PR", author: "provider" })).toBeNull();
  });

  it.each([
    ["Grêmio & Flamengo", "Gremio", "fixture"],
    ["atletico go and nautico", "Atletico GO", "fixture"],
    ["Grêmio X Flamengo", "Gremio", "fixture"],
    ["Flamengo (-1)", "Flamengo", "market"],
    ["Flamengo+1", "Flamengo", "market"],
    ["Flamengo ML", "Flamengo", "market"],
    ["Empate", "Flamengo", "market"],
  ] as const)("o conector e a linha sozinhos também: %s → %s", (nome, alvo, motivo) => {
    expect(teamAliasNameProblem(nome, { target: alvo, author: "tipster" })).toBe(motivo);
  });
});

describe("propriedades do filtro de nome", () => {
  it("dois clubes ligados por delimitador ou conector são dois times, não um", () => {
    fc.assert(
      fc.property(
        doisClubes,
        clube,
        fc.constantFrom(" vs ", " VS. ", " versus ", " x ", " X ", " v ", " / ", "/", " - ", " & ", "&", " and ", " e ", " + "),
        escopo,
        autoria,
        ([casa, fora, alvo], terceiro, separador, contexto, quem) => {
          // "+ 1. FC Union Berlin" também lê como linha ("+1"): recusado do mesmo jeito.
          const recusas = separador.trim() === "+" && /^\s*\d/.test(fora) ? ["fixture", "market"] : ["fixture"];
          expect(recusas).toContain(teamAliasNameProblem(`${casa}${separador}${fora}`, { ...contexto, ...quem, target: alvo }));
          expect(teamAliasNameProblem(`${casa} and ${fora} vs ${terceiro}`, { ...contexto, ...quem, target: alvo })).toBe("fixture");
        },
      ),
      PROPERTY_CONFIG,
    );
  });

  it("vaga não vira alias em nenhum contexto, de ninguém", () => {
    fc.assert(
      fc.property(fc.constantFrom(...VAGAS).chain(grafia), escopo, autoria, clube, (vaga, contexto, quem, alvo) => {
        expect(teamAliasNameProblem(vaga, { ...contexto, ...quem, target: alvo })).toBe("placeholder");
      }),
      PROPERTY_CONFIG,
    );
  });

  it("nome cortado e a seleção da aposta nunca viram alias", () => {
    fc.assert(
      fc.property(
        clube,
        fc.constantFrom("...", "…", " ..."),
        fc.constantFrom(" over 2.5", " Under 1,5", " -1.5", " (-1)", "+1", " +0.5", " ML", " @1.85", " DNB", " 2u", " to win"),
        escopo,
        autoria,
        (nome, reticencias, linha, contexto, quem) => {
          expect(teamAliasNameProblem(`${nome}${reticencias}`, { ...contexto, ...quem, target: nome })).toBe("ellipsis");
          expect(teamAliasNameProblem(`${nome}${linha}`, { ...contexto, ...quem, target: nome })).toBe("market");
        },
      ),
      PROPERTY_CONFIG,
    );
  });

  it("grafias reais passam, com conector, barra, sigla ou país dentro do nome", () => {
    const real = fc.constantFrom(...GRAFIAS_REAIS).chain(([nome, alvo]) =>
      grafia(nome).map((variante) => [variante, alvo] as const));
    fc.assert(
      fc.property(real, escopo, autoria, ([variante, alvo], contexto, quem) => {
        expect(teamAliasNameProblem(variante, { ...contexto, ...quem, target: alvo }), variante).toBeNull();
      }),
      PROPERTY_CONFIG,
    );
  });

  it("só o texto do tipster sem país e competição cai na regra de genérico", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...GENERICOS).chain(grafia),
        fc.constantFrom("", "World", "Europe", "International"),
        fc.constantFrom("", "Cup", "Liga", "League"),
        fc.constantFrom("AUTO", "LLM", undefined),
        (nome, paisVago, competicaoVaga, origem) => {
          const tipster = { author: "tipster" as const, source: origem, target: "Clube" };
          expect(teamAliasNameProblem(nome, { ...tipster, country: paisVago, competition: "Liga Profesional" })).toBe("generic");
          expect(teamAliasNameProblem(nome, { ...tipster, country: "Argentina", competition: competicaoVaga })).toBe("generic");
          expect(teamAliasNameProblem(nome, { ...tipster, country: "Argentina", competition: "Liga Profesional" })).toBeNull();
          // O provider chama o clube assim; o dono e o uso repetido já decidiram.
          expect(teamAliasNameProblem(nome, { author: "provider", source: origem, target: "Clube" })).toBeNull();
          expect(teamAliasNameProblem(nome, { author: "tipster", source: "MANUAL", target: "Clube" })).toBeNull();
          expect(teamAliasNameProblem(nome, { author: "tipster", source: "PROMOTED", target: "Clube" })).toBeNull();
        },
      ),
      PROPERTY_CONFIG,
    );
  });

  it("país só vale para a própria seleção, com ou sem categoria", () => {
    const pais = fc.constantFrom(...PAISES).chain(([nome, selecao]) =>
      grafia(nome).map((variante) => [variante, selecao] as const));
    fc.assert(
      fc.property(pais, clube, escopo, autoria, ([nome, selecao], alvoClube, contexto, quem) => {
        expect(teamAliasNameProblem(nome, { ...contexto, ...quem, target: selecao }), nome).toBeNull();
        expect(teamAliasNameProblem(nome, { ...contexto, ...quem, target: alvoClube }), nome).toBe("country");
      }),
      PROPERTY_CONFIG,
    );
  });

  it("o veredito não depende de caixa, acento nem espaços", () => {
    const qualquerNome = fc.constantFrom(
      ...GRAFIAS_REAIS.map(([nome]) => nome), ...VAGAS, ...GENERICOS,
      "Grêmio vs Inter", "Grêmio x Inter", "Grêmio X Inter", "GRÊMIO X INTER", "Grêmio & Inter", "Flamengo ML",
    ).chain((nome) => grafia(nome).map((variante) => [nome, variante] as const));
    fc.assert(
      fc.property(qualquerNome, escopo, autoria, fc.constantFrom("Alvo", "Gremio", "Brighton and Hove Albion"),
        ([nome, variante], contexto, quem, alvo) => {
          expect(teamAliasNameProblem(variante, { ...contexto, ...quem, target: alvo }), variante)
            .toBe(teamAliasNameProblem(nome, { ...contexto, ...quem, target: alvo }));
        }),
      PROPERTY_CONFIG,
    );
  });

  it("letra solta, número, categoria e sigla de tipo de clube não nomeiam clube", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("B", "1", "FC", "SC", "U20", "Women", "II", "FC 1", "Club", "A"),
        escopo,
        autoria,
        (nome, contexto, quem) => {
          expect(teamAliasNameProblem(nome, { ...contexto, ...quem, target: "Alvo" })).toBe("empty");
        },
      ),
      PROPERTY_CONFIG,
    );
  });
});

describe("texto arbitrário", () => {
  const texto = fc.oneof(fc.string(), fc.string({ unit: "grapheme" }), fc.string({ unit: "binary" }));

  it("todo texto recebe um veredito do vocabulário, sem erro", () => {
    fc.assert(
      fc.property(texto, texto, escopo, autoria, (nome, alvo, contexto, quem) => {
        const veredito = teamAliasNameProblem(nome, { ...contexto, ...quem, target: alvo });
        expect(veredito === null || PROBLEMS.includes(veredito)).toBe(true);
      }),
      PROPERTY_CONFIG,
    );
  });

  it("um clube e qualquer outro nome ligados por \"vs\" nunca viram alias do clube", () => {
    const outroNome = texto.filter((nome) => {
      const palavras = tokens(nome);
      return palavras.join("").length >= 2 && !palavras.every((palavra) => palavra.length < 3);
    });
    fc.assert(
      fc.property(fc.constantFrom(...CLUBES), outroNome, escopo, autoria, (nome, outro, contexto, quem) => {
        const clubeInteiro = tokens(nome);
        fc.pre(!tokens(outro).every((palavra) => clubeInteiro.some((token) => mesmaPalavra(token, palavra))));
        expect(teamAliasNameProblem(`${nome} vs ${outro}`, { ...contexto, ...quem, target: nome })).not.toBeNull();
      }),
      PROPERTY_CONFIG,
    );
  });

  it("qualquer texto com a linha da aposta nunca vira alias", () => {
    fc.assert(
      fc.property(texto, fc.constantFrom(" -1.5", " @2.10", " +0.25", "(-1)", " 1,85"), escopo, autoria,
        (nome, linha, contexto, quem) => {
          expect(teamAliasNameProblem(`${nome}${linha}`, { ...contexto, ...quem, target: nome })).not.toBeNull();
        }),
      PROPERTY_CONFIG,
    );
  });
});

describe("nationalTeamCountry", () => {
  it("é o país quando o nome é a seleção, com categoria ou qualificador; clube com país no nome não é", () => {
    expect(nationalTeamCountry("Brazil U20")).toBe("Brazil");
    expect(nationalTeamCountry("China PR")).toBe("China");
    expect(nationalTeamCountry("Alemanha")).toBe("Germany");
    expect(nationalTeamCountry("Brasil de Pelotas")).toBeNull();
    expect(nationalTeamCountry("Havelse")).toBeNull();
  });
});
