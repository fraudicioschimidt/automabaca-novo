import { describe, expect, it } from "vitest";
import {
  CANONICAL_SPORTS,
  COMPETITION_SIGNALS,
  EMOJI_SIGNALS,
  SPORTS_REGISTRY,
  TEXT_SIGNALS,
  canonicalSport,
  esportesComUnidade,
  termosDeUnidadeSemPlacar,
} from "@/src/domain/sports/registry";
import { detectSportFromText } from "@/src/domain/sports/detect";
import type { CanonicalSport } from "@/src/domain/sports/registry";
import {
  SCORE_UNIT_RULES,
  hasScoreUnitMismatch,
} from "@/src/domain/mercados/stat-qualifier";
import {
  FLASHSCORE_CANONICAL_SPORTS,
  flashscoreSportId,
  flashscoreSportPerfil,
  FLASHSCORE_SPORT_IDS_SO_DO_PROVIDER,
} from "@/src/providers/flashscore/sports";
import { normalizeStr } from "@/src/domain/text";
import { SHARP_PROVIDER_ORDER, providerCoversSport } from "@/src/providers/coverage";
import { SPORT_OPTIONS } from "@/app/_design/lib/sport-options";

/**
 * O registro só cumpre a promessa se as listas DERIVADAS não puderem divergir
 * dele. Este arquivo é o mecanismo: se alguém acrescentar um esporte e esquecer
 * de medir o id do FlashScore, de declarar a unidade do placar ou de conferir a
 * cobertura de odds, é aqui que estoura — não em produção, com dinheiro.
 */

describe("registro de esportes", () => {
  it("não tem canônico nem alias repetido entre modalidades", () => {
    const vistos = new Map<string, string>();
    for (const entry of SPORTS_REGISTRY) {
      for (const nome of [entry.canonical, ...entry.aliases]) {
        const chave = nome.toLowerCase();
        const dono = vistos.get(chave);
        expect(dono, `"${nome}" já pertence a ${dono}`).toBeUndefined();
        vistos.set(chave, entry.canonical);
      }
    }
  });

  it("todo canônico e todo alias voltam pelo canonicalSport", () => {
    for (const entry of SPORTS_REGISTRY) {
      for (const nome of [entry.canonical, ...entry.aliases]) {
        expect(canonicalSport(nome), nome).toBe(entry.canonical);
        // Como o operador digita: caixa e acento não podem mudar a resposta.
        expect(canonicalSport(nome.toUpperCase()), nome).toBe(entry.canonical);
      }
    }
  });

  it("as listas de sinal derivam do registro, sem sobra nem falta", () => {
    expect(CANONICAL_SPORTS).toHaveLength(SPORTS_REGISTRY.length);
    expect([...CANONICAL_SPORTS]).toEqual(SPORTS_REGISTRY.map((e) => e.canonical));
    expect(EMOJI_SIGNALS).toHaveLength(
      SPORTS_REGISTRY.reduce((total, e) => total + e.emojis.length, 0),
    );
    expect(TEXT_SIGNALS).toHaveLength(
      SPORTS_REGISTRY.filter((e) => e.texto !== null).length,
    );
    expect(COMPETITION_SIGNALS).toHaveLength(
      SPORTS_REGISTRY.filter((e) => e.competicoes !== null).length,
    );
  });

  it("todo esporte com id do FlashScore é achável pelo nome canônico", () => {
    for (const entry of SPORTS_REGISTRY) {
      if (entry.flashscoreId === null) continue;
      expect(flashscoreSportId(entry.canonical), entry.canonical).toBe(entry.flashscoreId);
      expect(flashscoreSportPerfil(entry.flashscoreId), entry.canonical).not.toBeNull();
    }
  });

  it("FLASHSCORE_CANONICAL_SPORTS casa por id, não por nome", () => {
    const esperados = SPORTS_REGISTRY.filter(
      (e) => e.flashscoreId !== null && flashscoreSportPerfil(e.flashscoreId) !== null,
    );
    expect(FLASHSCORE_CANONICAL_SPORTS).toHaveLength(esperados.length);
    // Rugby é o caso que a comparação textual perdia: o registro chama de
    // "Rugby" e o provider de "Rugby Union".
    const rugby = FLASHSCORE_CANONICAL_SPORTS.find((item) => item.sport === "Rugby");
    expect(rugby?.sportId).toBe(8);
  });

  it("toda modalidade nova tem caminho: liquida no FlashScore OU tem odds", () => {
    for (const entry of SPORTS_REGISTRY) {
      const perfil =
        entry.flashscoreId === null ? null : flashscoreSportPerfil(entry.flashscoreId);
      const liquida = perfil !== null && perfil.modo !== "nenhum";
      const temOdds = SHARP_PROVIDER_ORDER.some((provider) => providerCoversSport(provider, entry.canonical));
      expect(
        liquida || temOdds,
        `${entry.canonical} não liquida no FlashScore nem tem provider de odds — ` +
          "aposta nele ficaria órfã dos dois lados",
      ).toBe(true);
    }
  });

  it("SCORE_UNIT_RULES deriva do registro e mantém os termos legados", () => {
    expect(SCORE_UNIT_RULES.goals.sports).toEqual(esportesComUnidade("gols"));
    expect(SCORE_UNIT_RULES.points.sports).toEqual(esportesComUnidade("pontos"));
    expect(SCORE_UNIT_RULES.points.sports).toContain("basketball");
    expect(SCORE_UNIT_RULES.points.sports).toContain("american football");
    expect(SCORE_UNIT_RULES.points.sports).toContain("nfl");
    expect(SCORE_UNIT_RULES.points.sports).toContain("rugby");
    // Softbol não é canônico e continua explícito na regra (dado legado).
    expect(SCORE_UNIT_RULES.runs.sports).toContain("softball");
    expect(SCORE_UNIT_RULES.runs.sports).toContain("cricket");
    expect(SCORE_UNIT_RULES.runs.sports).toContain("baseball");
  });

  /**
   * Unidade que o feed NÃO entrega precisa falhar fechado: liquidar pelo número
   * errado inverte dinheiro. Vale para cada modalidade com unidade própria —
   * dardos conta legs, snooker conta frames, vôlei de praia conta sets, e
   * "Total de Pontos" em nenhum deles é o número do placar.
   */
  it("unidade fora do placar da modalidade continua falhando fechado", () => {
    for (const esporte of ["Darts", "Snooker", "Beach Volleyball", "Table Tennis", "Handball", "Futsal"]) {
      expect(hasScoreUnitMismatch("Total de Pontos", "Mais de 5.5", esporte), esporte).toBe(true);
    }
    // Onde ponto É o placar, o mercado passa.
    expect(hasScoreUnitMismatch("Total de Pontos", "Mais de 200.5", "Basketball")).toBe(false);
    expect(hasScoreUnitMismatch("Total de Pontos", "Mais de 45.5", "Rugby")).toBe(false);
    // Corridas só em beisebol e críquete.
    expect(hasScoreUnitMismatch("Total de Corridas", "Mais de 8.5", "Cricket")).toBe(false);
    expect(hasScoreUnitMismatch("Total de Corridas", "Mais de 8.5", "Handball")).toBe(true);
    expect(hasScoreUnitMismatch("Total de Gols", "Under 2.5", "Futebol americano")).toBe(true);
    expect(hasScoreUnitMismatch("Total de Gols", "Under 2.5", "Basketball")).toBe(true);
    expect(hasScoreUnitMismatch("Total de Gols", "Under 2.5", "Futsal")).toBe(false);
    // Handicap por gols segue liquidável onde o placar é gols.
    expect(hasScoreUnitMismatch("Handicap", "Handebol A -3.5", "Handball")).toBe(false);
  });

  it("todo esporte do registro é detectável pelo próprio nome", () => {
    for (const entry of SPORTS_REGISTRY) {
      if (!entry.texto) continue;
      const decisao = detectSportFromText(entry.canonical);
      expect(decisao.sport, entry.canonical).toBe(entry.canonical);
      expect(decisao.status, entry.canonical).toBe("CONFIRMED");
    }
  });
});

describe("mapa de ids do FlashScore", () => {
  const chave = (nome: string) => normalizeStr(nome).replace(/\s+/g, "");

  /**
   * A lista auxiliar do provider não pode nomear nada que o registro já nomeia.
   *
   * "rugbyleague" apontava para 19 nela enquanto o registro o declarava alias
   * de `Rugby` (id 8). Duas respostas para a mesma pergunta, e quem decidia era
   * a ordem de inserção no `Map` — o tipo de conflito que não dá erro, não dá
   * teste vermelho e um dia liquida a partida errada.
   */
  it("grafias do provider não colidem com o registro do domínio", () => {
    const doRegistro = new Set(
      SPORTS_REGISTRY.flatMap((entry) => [entry.canonical, ...entry.aliases]).map(chave),
    );
    const colisoes = FLASHSCORE_SPORT_IDS_SO_DO_PROVIDER
      .map(([nome]) => nome)
      .filter((nome) => doRegistro.has(nome));
    expect(colisoes).toEqual([]);
  });

  it("uma modalidade do registro resolve sempre para o mesmo id", () => {
    for (const entry of SPORTS_REGISTRY) {
      if (entry.flashscoreId === null) continue;
      for (const nome of [entry.canonical, ...entry.aliases]) {
        expect(flashscoreSportId(nome), nome).toBe(entry.flashscoreId);
      }
    }
  });
});

/**
 * O registro (`unidadeDoPlacar`) e a tabela de tratamento não podem dar
 * afirmações opostas sobre o mesmo fato. Recusar o que nunca foi medido é a
 * regra da casa, e a recusa tem de vir pelo motivo certo: motivo errado é o que
 * faz a próxima pessoa consertar o lado errado.
 */
describe("unidade do placar — recusa com o motivo certo", () => {
  it("as unidades sem medição do registro recusam a linha", () => {
    // `outra` (luta, golfe) fica de fora: lá não há contagem entre dois lados.
    // As demais são pendência de medição, não impossibilidade — e a lista é o
    // roteiro do que dá para destravar.
    const usadas = new Set(SPORTS_REGISTRY.map((e) => e.unidadeDoPlacar));
    const termos = termosDeUnidadeSemPlacar().join("|");
    for (const unidade of ["frames", "games", "legs", "mapas", "sets"] as const) {
      if (!usadas.has(unidade)) continue;
      // O termo é derivado da unidade; divergir aqui deixa dardos e snooker
      // liquidando contra um placar de unidade desconhecida.
      expect(termos, unidade).toContain(unidade.slice(0, 4));
    }
  });
});

describe("seletor de modalidade do cadastro manual", () => {
  /**
   * A tela oferecia Rugby, MMA, Boxing e Golf quando `canonicalSport` ainda não
   * os conhecia: o operador escolhia e a server action recusava com
   * "Selecione uma modalidade esportiva reconhecida". Toda opção do seletor
   * PRECISA ser aceita pelo mesmo parser que a server action usa.
   */
  it("toda opção do seletor é aceita pelo canonicalSport", () => {
    expect(SPORT_OPTIONS.length).toBe(SPORTS_REGISTRY.length);
    for (const opcao of SPORT_OPTIONS) {
      expect(canonicalSport(opcao.value), opcao.label).toBe(opcao.value);
      expect(opcao.label.length, opcao.value).toBeGreaterThan(0);
    }
  });
});

describe('competição compartilhada não sobrepõe modalidade explícita', () => {
  it.each([['🤾', 'Handball'], ['🏐', 'Volleyball'], ['🏀', 'Basketball'], ['⚽', 'Soccer']])('%s Champions League', (emoji, sport) => {
    expect(detectSportFromText(`${emoji} Europe - Champions League`)).toMatchObject({ sport, status: 'CONFIRMED' });
  });
  it('mantém conflito entre dois sinais explícitos', () => {
    expect(detectSportFromText('⚽ 🤾 Europe - Champions League').status).toBe('CONFLICT');
    expect(detectSportFromText('🤾 Futebol - Champions League').status).toBe('CONFLICT');
  });
});

/** "serie [abcd]" e "la liga" também nomeiam ligas de basquete. */
describe("ligas com nome de liga de futebol", () => {
  it.each([
    "Lega Basket Serie A",
    "La Liga Endesa",
    "Real Madrid Baloncesto - La Liga Endesa",
    "Basquete Serie A",
  ])("%s não é futebol", (texto) => {
    expect(detectSportFromText(texto).sport).toBe("Basketball");
  });

  // Os nomes da modalidade em espanhol e português europeu e as federações
  // também nomeiam a modalidade e a liga dela.
  it.each([
    ["Baloncesto - La Liga", "Basketball"],
    ["Basquetebol Serie A", "Basketball"],
    ["FIBA Champions League", "Basketball"],
    ["Voleibol Serie A", "Volleyball"],
    ["CEV Champions League", "Volleyball"],
    ["PDC Premier League - Littler x Humphries", "Darts"],
  ] as const)("%s é %s", (texto, sport) => {
    expect(detectSportFromText(texto)).toMatchObject({ sport, status: "CONFIRMED" });
  });

  // A liga compartilhada não prova futebol: o item que a IA leu em outra
  // modalidade vai para quem acha o jogo, mesmo sem o nome dela no texto.
  it.each([
    ["Serie A", "Basketball"],
    ["Itália - Serie A", "Basketball"],
    ["La Liga\nReal Madrid -4.5", "Basketball"],
    ["Bundesliga", "Basketball"],
    ["Champions League", "Volleyball"],
    ["Premier League\nLittler x Humphries", "Darts"],
  ] as const)("%j lido como %s não confirma futebol", (texto, sport) => {
    expect(detectSportFromText(texto, { itemSport: sport })).toMatchObject({ sport: null, status: "PENDING" });
  });

  it("a liga só do futebol não cede à leitura do item", () => {
    expect(detectSportFromText("Brasileirão", { itemSport: "Basketball" })).toMatchObject({ sport: "Soccer", status: "CONFIRMED" });
    expect(detectSportFromText("Serie A", { itemSport: "Soccer" })).toMatchObject({ sport: "Soccer", status: "CONFIRMED" });
  });

  it.each(["Serie A", "Italia Serie A", "La Liga", "Premier League", "Flamengo vs Palmeiras Serie A", "Italia\nSerie A\nFlamengo x Palmeiras", "⚽ Serie A"])(
    "%s continua futebol",
    (texto) => {
      expect(detectSportFromText(texto)).toMatchObject({ sport: "Soccer", status: "CONFIRMED" });
    },
  );

  // A captura junta legenda, competição e mercado em linhas: o item lido como a
  // modalidade que o texto nomeia leva a liga compartilhada, em qualquer linha.
  const sharedLeagues: Array<[string, CanonicalSport]> = [
    ["🏀 Basquete\nSerie A - Virtus Bologna x Olimpia Milano\nOver 160.5", "Basketball"],
    ["🏀 Itália - Serie A - Virtus x Olimpia", "Basketball"],
    ["🏀\nLa Liga - Real Madrid x Barcelona", "Basketball"],
    ["Basquete\nBundesliga - Bayern x Alba", "Basketball"],
    ["Basquete Bundesliga - Bayern x Alba", "Basketball"],
    ["Basket Bundesliga - Bayern x Alba", "Basketball"],
    ["Basket\nBundesliga - Bayern x Alba", "Basketball"],
    ["3 pontos: Mais de 2.5\nBasquete Bundesliga - Bayern x Alba", "Basketball"],
    ["🏐\nSerie A - Perugia x Trento", "Volleyball"],
  ];
  it.each(sharedLeagues)("%j lido como %s confirma a modalidade", (texto, sport) => {
    expect(detectSportFromText(texto, { itemSport: sport })).toMatchObject({ sport, status: "CONFIRMED" });
  });

  it.each(sharedLeagues)("%j lido como futebol fica em conflito", (texto) => {
    expect(detectSportFromText(texto, { itemSport: "Soccer" }).status).toBe("CONFLICT");
  });

  it("palavra da modalidade em outra linha também segura o futebol", () => {
    expect(detectSportFromText("Lega Volley\nSerie A - Perugia x Trento")).toMatchObject({ sport: null, status: "PENDING" });
    expect(detectSportFromText("Real Madrid x Barcelona\nLa Liga\nEndesa")).toMatchObject({ sport: null, status: "PENDING" });
    // A palavra que o registro não conhece não vira futebol nem com a leitura do item.
    expect(detectSportFromText("Lega Volley\nSerie A - Perugia x Trento", { itemSport: "Soccer" }))
      .toMatchObject({ sport: null, status: "PENDING" });
  });

  // No lote, a legenda inteira do post entra para cada item: a outra
  // modalidade pode ser de outro jogo do post.
  const mixedPosts = [
    "🎾 Sinner x Alcaraz - Sinner ML @1.80\nFlamengo x Botafogo - Série A - Over 2.5 @1.90",
    "Múltipla do dia\n🏀 Lakers x Celtics - Over 220.5\nJuventus x Milan (Serie A) - Over 2.5",
    "🏒 NHL Rangers ML\nBundesliga - Bayern x Dortmund",
    "Serie A - Juventus x Milan - Over 2.5\nVôlei: Perugia x Trento - Over 180.5",
    "🎮 Jogo do dia: Juventus x Milan - Serie A",
    "Serie A - Juventus x Milan\nOver 2.5\n\nVIP de basquete: t.me/canal",
    "La Liga - Real Madrid x Barcelona\nAmbas marcam\n\n🏀 Entre no canal da NBA",
    "Basket\nBundesliga - Bayern x Dortmund",
  ];
  it.each(mixedPosts)("post misto %j: o item lido como futebol, ou sem leitura, fica em conflito", (texto) => {
    expect(detectSportFromText(texto, { itemSport: "Soccer" }).status).toBe("CONFLICT");
    expect(detectSportFromText(texto).status).toBe("CONFLICT");
  });

  it("post misto: o item lido como a outra modalidade a confirma", () => {
    expect(detectSportFromText(mixedPosts[0] ?? "", { itemSport: "Tennis" })).toMatchObject({ sport: "Tennis", status: "CONFIRMED" });
    expect(detectSportFromText(mixedPosts[1] ?? "", { itemSport: "Basketball" })).toMatchObject({ sport: "Basketball", status: "CONFIRMED" });
  });

  it.each(["🤾 EHF Champions League - Veszprém x Kiel", "EHF Champions League - Veszprém x Kiel"])("%s é handebol", (texto) => {
    expect(detectSportFromText(texto)).toMatchObject({ sport: "Handball", status: "CONFIRMED" });
  });

  it("estatística de outra modalidade ou liga só do futebol no texto: conflito", () => {
    for (const texto of [
      "Serie A - Juventus x Milan\nVlahovic mais de 1.5 rebotes",
      "Champions League - Real Madrid x City\nCestas de 3: Mais de 4.5",
      "⚽ 🏀 Serie A",
      "🏀 Serie A\nPremier League",
    ]) {
      expect(detectSportFromText(texto).status, texto).toBe("CONFLICT");
    }
  });

  it("os 3 pontos da vitória são do futebol, não cesta de três", () => {
    expect(detectSportFromText("Serie A - Juventus x Milan\nA Juve precisa dos 3 pontos"))
      .toMatchObject({ sport: "Soccer", status: "CONFIRMED" });
  });
});
