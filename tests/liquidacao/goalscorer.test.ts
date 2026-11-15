import { describe, expect, it } from "vitest";
import {
  GOALSCORER_MIN_SIMILARIDADE,
  tokensDaSelecao,
  requiredPlayerGoals,
  resolveGoalscorer,
  resolveOrderedGoalscorer,
  ehMercadoArtilheiro,
  ehMercadoArtilheiroPorTempo,
  hasUnsupportedGoalQualifier,
  orderedGoalscorerMarketOrder,
  similaridadeDeTokens,
  tokensDoNome,
  type JogadorDaPartida,
} from "@/src/domain/settlement/goalscorer";
import { resolvePeriodGoalscorer } from "@/src/domain/settlement/goalscorer-period";

const similaridadeDeNome = (a: string, b: string): number =>
  similaridadeDeTokens(tokensDoNome(a), tokensDoNome(b));

/**
 * Casos REAIS do corpus da sonda (`reports/flashscore-probe/raw`). Nome de
 * jogador é mais ambíguo que nome de time, então o que este arquivo protege não
 * é só o acerto — é a RECUSA: dois homônimos, gol contra e nome que não casa
 * têm que virar decisão humana, nunca chute liquidado.
 */

const jogador = (
  nome: string,
  gols: number,
  extra: Partial<JogadorDaPartida> = {},
): JogadorDaPartida => ({
  playerId: nome.replace(/\W/g, ""),
  nome,
  gols,
  golsContra: 0,
  // O feed medido publica os minutos de todo jogador listado (reserva = 0).
  minutosJogados: 90,
  ...extra,
});

// Partida A9tzvkkC medida: o feed escreve Sobrenome Nome, e "Rick" e mononome.
const PARTIDA_REAL: JogadorDaPartida[] = [
  jogador("Cristaldo Franco", 1),
  jogador("Rick", 2),
  jogador("Depietri Valentin", 1),
  jogador("Aguirre Thiago", 0),
  jogador("Santos Michael", 0),
];

describe("tokens e similaridade de nome de jogador", () => {
  it("descarta partícula e pontuação, preserva o resto", () => {
    expect(tokensDoNome("Van der Sar E.")).toEqual(["sar", "e"]);
    expect(tokensDoNome("D'Alessandro")).toEqual(["d", "alessandro"]);
    expect(tokensDoNome("Vinícius Júnior")).toEqual(["vinicius"]);
  });

  it("ignora a ORDEM — o feed escreve Sobrenome Nome", () => {
    // O caso que uma comparação posicional erraria em quase todo nome latino.
    expect(similaridadeDeNome("Franco Cristaldo", "Cristaldo Franco")).toBe(1);
    expect(similaridadeDeNome("Mauricio Martinez", "Martinez Mauricio")).toBe(1);
  });

  it("aceita inicial como evidência FRACA, não como igualdade", () => {
    const comInicial = similaridadeDeNome("Cristaldo F.", "Cristaldo Franco");
    expect(comInicial).toBeGreaterThan(0.7);
    expect(comInicial).toBeLessThan(1);
  });

  it("sobrenome isolado não vale nome completo", () => {
    // "Silva" contra "Silva Rodrigo" precisa ficar ABAIXO do limiar: é
    // exatamente o caso em que dois jogadores da partida empatariam.
    expect(similaridadeDeNome("Silva", "Silva Rodrigo")).toBeLessThan(
      GOALSCORER_MIN_SIMILARIDADE,
    );
  });

  it("mononome casa consigo mesmo", () => {
    expect(similaridadeDeNome("Rick", "Rick")).toBe(1);
  });

  it("nomes diferentes não casam", () => {
    expect(similaridadeDeNome("Haaland", "Cristaldo Franco")).toBe(0);
  });
});

describe("nome dentro do texto da seleção", () => {
  it("tira o mercado colado pela casa", () => {
    expect(tokensDaSelecao("Haaland - Marcar a qualquer momento")).toEqual(["haaland"]);
    expect(tokensDaSelecao("Franco Cristaldo Sim")).toEqual(["franco", "cristaldo"]);
    expect(tokensDaSelecao("Rick — Para marcar")).toEqual(["rick"]);
  });

  it("seleção sem nenhum nome é recusa explícita", () => {
    expect(resolveGoalscorer({ selecao: "Sim", jogadores: PARTIDA_REAL })).toMatchObject({
      ok: false,
      reason: "selecao_sem_jogador",
    });
  });

  /**
   * Acento não pode comer o nome.
   *
   * Em JS `\b` trata letra acentuada como não-palavra: rodando a remoção do
   * vocabulário de mercado sobre o texto CRU, `\bsim\b` casaria dentro de
   * "Simão" e `\bno\b` dentro de "Noé". O jogador viraria
   * `jogador_nao_encontrado` e o alerta acusaria o feed de um estrago nosso —
   * enquanto o MESMO nome sem acento casaria e liquidaria.
   */
  it("nome acentuado sobrevive ao filtro de vocabulário", () => {
    expect(tokensDaSelecao("Simão Pedro")).toEqual(["simao", "pedro"]);
    expect(tokensDaSelecao("Noé Baba")).toEqual(["noe", "baba"]);
    expect(tokensDaSelecao("Simão")).toEqual(["simao"]);
    // E o acentuado casa igual ao sem acento: sem assimetria.
    expect(tokensDaSelecao("Simão Pedro")).toEqual(tokensDaSelecao("Simao Pedro"));
  });

  it("acentuado liquida como o sem acento", () => {
    const jogadores = [
      { playerId: "p1", nome: "Simao Pedro", nomeCurto: "Simao P.", gols: 1, golsContra: 0, minutosJogados: 90 },
      { playerId: "p2", nome: "Baba Noe", nomeCurto: "Baba N.", gols: 0, golsContra: 0, minutosJogados: 90 },
    ];
    expect(resolveGoalscorer({ selecao: "Simão Pedro", jogadores })).toMatchObject({
      ok: true,
      status: "WON",
    });
    expect(resolveGoalscorer({ selecao: "Noé Baba", jogadores })).toMatchObject({
      ok: true,
      status: "LOST",
    });
  });
});

describe("resolveGoalscorer", () => {
  it("liquida WON com o nome na ordem do apostador", () => {
    const r = resolveGoalscorer({
      selecao: "Franco Cristaldo - Marcar a qualquer momento",
      jogadores: PARTIDA_REAL,
    });
    expect(r).toMatchObject({ ok: true, status: "WON" });
    expect(r.ok && r.jogador.nome).toBe("Cristaldo Franco");
  });

  it("liquida WON no mononome com dois gols", () => {
    expect(resolveGoalscorer({ selecao: "Rick", jogadores: PARTIDA_REAL })).toMatchObject({
      ok: true,
      status: "WON",
    });
  });

  it("liquida LOST quando o jogador existe e não marcou", () => {
    // Ausência de gol AQUI é informação positiva: a lista da partida encerrada
    // é completa, diferente de estatística que o feed simplesmente omite.
    expect(
      resolveGoalscorer({ selecao: "Thiago Aguirre", jogadores: PARTIDA_REAL }),
    ).toMatchObject({ ok: true, status: "LOST" });
  });

  it("recusa quando o nome não está na partida", () => {
    expect(
      resolveGoalscorer({ selecao: "Erling Haaland", jogadores: PARTIDA_REAL }),
    ).toMatchObject({ ok: false, reason: "jogador_nao_encontrado" });
  });

  it("recusa homônimos em vez de escolher um", () => {
    const r = resolveGoalscorer({
      selecao: "Silva",
      jogadores: [jogador("Silva", 1), jogador("Silva", 0)],
    });
    expect(r).toMatchObject({ ok: false, reason: "jogador_ambiguo" });
    expect(r.ok === false && r.candidatos).toHaveLength(2);
  });

  it("recusa quem tem gol contra — convenção da casa não é nossa de decidir", () => {
    expect(
      resolveGoalscorer({
        selecao: "Nicolas Otamendi",
        jogadores: [jogador("Otamendi Nicolas", 0, { golsContra: 1 })],
      }),
    ).toMatchObject({ ok: false, reason: "gol_contra_envolvido" });
  });

  it("recusa partida sem lista de jogadores", () => {
    expect(resolveGoalscorer({ selecao: "Rick", jogadores: [] })).toMatchObject({
      ok: false,
      reason: "sem_jogadores",
    });
  });

  it("usa o nome curto do feed quando é ele que casa", () => {
    const r = resolveGoalscorer({
      selecao: "Cristaldo F.",
      jogadores: [jogador("Cristaldo Franco", 1, { nomeCurto: "Cristaldo F." })],
    });
    expect(r).toMatchObject({ ok: true, status: "WON" });
  });

  /**
   * "Não" não pode ser apagado junto com "marcar"/"anytime": "marcar" é ruído e
   * "não" é O LADO DA APOSTA. Com o jogador marcando e a linha "não marca", o
   * settlement automático gravaria WON: dinheiro invertido sem revisão humana.
   * Recusa, não inversão: "Não marcar" e "No Goalscorer" (ninguém marca) são
   * mercados diferentes com grafia vizinha.
   */
  it.each([
    ["Haaland Erling Nao", undefined],
    ["Haaland - Não", undefined],
    ["Haaland Erling No", undefined],
    ["Haaland Erling", "Não marcar a qualquer momento"],
    ["Haaland Erling", "Player Not To Score"],
  ])("recusa linha que NEGA o gol: %s / %s", (selecao, mercado) => {
    expect(
      resolveGoalscorer({
        selecao,
        ...(mercado ? { mercado } : {}),
        jogadores: [jogador("Erling Haaland", 1)],
      }),
    ).toMatchObject({ ok: false, reason: "polaridade_negativa" });
  });

  /**
   * A detecção é por TOKEN no texto normalizado. Regex no cru quebraria nestes
   * nomes: `\bno\b` casa dentro de "Noé" e
   * `\bsim\b` dentro de "Simão".
   */
  it.each(["Noé Baba", "Noe Baba", "Simão Pedro", "Simao Pedro"])(
    "nome que CONTÉM negação não é polaridade: %s",
    (nome) => {
      expect(
        resolveGoalscorer({ selecao: nome, jogadores: [jogador(nome, 1)] }),
      ).toMatchObject({ ok: true, status: "WON" });
    },
  );
});

describe("mononome: sobrenome sozinho é a grafia normal do tipster", () => {
  const jogadores = [
    { playerId: "1", nome: "Haaland Erling", gols: 1, golsContra: 0 },
    { playerId: "2", nome: "Foden Phil", gols: 0, golsContra: 0 },
  ];

  it("um token exato que casa com UM jogador liquida", () => {
    // A nota máxima de 1 token contra um nome de 2 é 0.75, abaixo do limiar de
    // 0.82: sem este caminho, o Anytime mais comum do mundo ficaria em recusa.
    expect(
      resolveGoalscorer({ selecao: "Haaland", mercado: "Anytime Goalscorer", jogadores }),
    ).toMatchObject({ ok: true, status: "WON" });
  });

  it("dois jogadores com o mesmo sobrenome continuam ambíguos", () => {
    expect(
      resolveGoalscorer({
        selecao: "Silva",
        mercado: "Anytime Goalscorer",
        jogadores: [
          { playerId: "1", nome: "Silva Joao", gols: 1, golsContra: 0 },
          { playerId: "2", nome: "Silva Pedro", gols: 0, golsContra: 0 },
        ],
      }),
    ).toMatchObject({ ok: false, reason: "jogador_ambiguo" });
  });

  it("token que não é de ninguém continua sem casar", () => {
    expect(
      resolveGoalscorer({ selecao: "Mbappe", mercado: "Anytime Goalscorer", jogadores }),
    ).toMatchObject({ ok: false, reason: "jogador_nao_encontrado" });
  });

  it("a polaridade negativa continua vencendo o atalho de mononome", () => {
    expect(
      resolveGoalscorer({ selecao: "Haaland - Não", mercado: "Anytime Goalscorer", jogadores }),
    ).toMatchObject({ ok: false, reason: "polaridade_negativa" });
  });
  it("gol contra vence o atalho de mononome", () => {
    expect(
      resolveGoalscorer({
        selecao: "Haaland",
        mercado: "Anytime Goalscorer",
        jogadores: [
          { playerId: "1", nome: "Haaland Erling", gols: 1, golsContra: 1 },
          { playerId: "2", nome: "Foden Phil", gols: 0, golsContra: 0 },
        ],
      }),
    ).toMatchObject({ ok: false, reason: "gol_contra_envolvido" });
  });

  it("homônimo de nome COMPLETO continua caindo na guarda de vantagem", () => {
    // O atalho de mononome só vale para seleção de UM token; com dois, quem
    // decide é a margem até o segundo colocado — o caminho original.
    expect(
      resolveGoalscorer({
        selecao: "Silva Rodrigo",
        mercado: "Anytime Goalscorer",
        jogadores: [
          { playerId: "1", nome: "Silva Rodrigo", gols: 1, golsContra: 0 },
          { playerId: "2", nome: "Silva Rodrigo", gols: 0, golsContra: 0 },
        ],
      }),
    ).toMatchObject({
      ok: false,
      reason: "jogador_ambiguo",
      candidatos: ["Silva Rodrigo", "Silva Rodrigo"],
    });
  });
});

describe("T2-R2-BUG-02: reserva que não entrou (zero minuto no elenco)", () => {
  it("sai VOID, como fazem as casas, em qualquer quantidade de gols", () => {
    const jogadoresDNP = [
      jogador("Aguirre Thiago", 0, { minutosJogados: 0 }),
      jogador("Santos Michael", 0, { minutosJogados: 90 }),
    ];

    for (const mercado of ["Anytime Goalscorer", "To Score 2+ Goals", "To Score a Hat-trick"]) {
      expect(resolveGoalscorer({ selecao: "Thiago Aguirre", mercado, jogadores: jogadoresDNP }), mercado)
        .toMatchObject({ ok: true, status: "VOID" });
    }
  });

  it("zero minuto com gol é participação: liquida pelo gol", () => {
    const jogadores = [jogador("Aguirre Thiago", 1, { minutosJogados: 0 })];
    expect(resolveGoalscorer({ selecao: "Thiago Aguirre", jogadores }))
      .toMatchObject({ ok: true, status: "WON" });
  });

  it("zero minuto com a escalação dizendo que entrou não é VOID", () => {
    const jogadores = [jogador("Aguirre Thiago", 0, { minutosJogados: 0, participou: true })];
    expect(resolveGoalscorer({ selecao: "Thiago Aguirre", jogadores }))
      .toMatchObject({ ok: true, status: "LOST" });
  });

  it("liquida LOST quando o atleta jogou (minutosJogados > 0) e nao marcou", () => {
    const jogadores = [
      jogador("Aguirre Thiago", 0, { minutosJogados: 45 }),
    ];

    expect(
      resolveGoalscorer({ selecao: "Thiago Aguirre", jogadores }),
    ).toMatchObject({ ok: true, status: "LOST" });
  });

  it("feed sem minutos e sem gol recusa: não separa \"não marcou\" de \"não entrou\"", () => {
    const jogadores = [
      jogador("Aguirre Thiago", 0, { minutosJogados: undefined }),
    ];

    expect(
      resolveGoalscorer({ selecao: "Thiago Aguirre", jogadores }),
    ).toEqual({ ok: false, reason: "participacao_nao_comprovada" });
  });

  it("feed sem minutos com a entrada provada pela escalação liquida LOST", () => {
    const jogadores = [
      jogador("Aguirre Thiago", 0, { minutosJogados: undefined, participou: true }),
    ];

    expect(
      resolveGoalscorer({ selecao: "Thiago Aguirre", jogadores }),
    ).toMatchObject({ ok: true, status: "LOST" });
  });

  it("\"To Score 2+ Goals\" pede dois gols: um gol sai LOST, dois saem WON", () => {
    for (const mercado of ["To Score 2+ Goals", "Marcar 2+ Gols", "Bis", "Brace", "2 ou mais gols"]) {
      expect(resolveGoalscorer({ selecao: "Thiago Aguirre", mercado, jogadores: [jogador("Aguirre Thiago", 1)] }), mercado)
        .toMatchObject({ ok: true, status: "LOST" });
      expect(resolveGoalscorer({ selecao: "Thiago Aguirre", mercado, jogadores: [jogador("Aguirre Thiago", 2)] }), mercado)
        .toMatchObject({ ok: true, status: "WON" });
    }
    expect(resolveGoalscorer({ selecao: "Thiago Aguirre", mercado: "Anytime Goalscorer", jogadores: [jogador("Aguirre Thiago", 1)] }))
      .toMatchObject({ ok: true, status: "WON" });
  });

  it("\"2+ gols\" com 1 gol e sem minutos liquida LOST: o gol prova a entrada", () => {
    const jogadores = [
      jogador("Aguirre Thiago", 1, { minutosJogados: undefined }),
    ];

    expect(
      resolveGoalscorer({ selecao: "Thiago Aguirre", mercado: "To Score 2+ Goals", jogadores }),
    ).toMatchObject({ ok: true, status: "LOST" });
  });

  it("feed sem minutos com gol liquida WON: o gol prova a entrada", () => {
    const jogadores = [
      jogador("Aguirre Thiago", 1, { minutosJogados: undefined }),
    ];

    expect(
      resolveGoalscorer({ selecao: "Thiago Aguirre", jogadores }),
    ).toMatchObject({ ok: true, status: "WON" });
  });

  it("liquida WON normalmente quando o atleta marcou gol", () => {
    const jogadores = [
      jogador("Cristaldo Franco", 1, { minutosJogados: 75 }),
    ];

    expect(
      resolveGoalscorer({ selecao: "Franco Cristaldo", jogadores }),
    ).toMatchObject({ ok: true, status: "WON" });
  });
});

describe("T2-R3-BUG-02: Anytime Goalscorer restrito ao tempo regulamentar (FT)", () => {
  it.each([
    "Anytime Goalscorer 1T",
    "Marcar a Qualquer Momento - 1º Tempo",
    "Half Time Goalscorer",
    "HT Goalscorer",
    "1H Goalscorer",
    "Anytime Goalscorer 2H",
    "Anytime Goalscorer Extra Time",
  ])("recusa mercado de artilheiro de período específico: %s", (mercado) => {
    expect(ehMercadoArtilheiro(mercado)).toBe(false);
  });

  it.each([
    "Anytime Goalscorer",
    "Marcar a qualquer momento",
    "Anytime Scorer",
    "Goalscorer",
  ])("aceita mercado de artilheiro do confronto completo (FT): %s", (mercado) => {
    expect(ehMercadoArtilheiro(mercado)).toBe(true);
  });

  it("recusa ehMercadoArtilheiro e resolveGoalscorer quando selecao declara periodo especifico (HT/1T)", () => {
    expect(ehMercadoArtilheiro("Anytime Goalscorer", "Erling Haaland - 1st Half")).toBe(false);
    expect(ehMercadoArtilheiro("Anytime Goalscorer", "Erling Haaland - 1T")).toBe(false);
    expect(ehMercadoArtilheiro("Anytime Goalscorer", "Erling Haaland - 1º Tempo")).toBe(false);

    const jogadores = [
      { nome: "Erling Haaland", gols: 1, golsContra: 0, playerId: "p1", minutosJogados: 90 },
    ];
    const res = resolveGoalscorer({
      selecao: "Erling Haaland - 1st Half",
      mercado: "Anytime Goalscorer",
      jogadores,
    });
    expect(res).toEqual({ ok: false, reason: "periodo_nao_suportado" });
  });

  it("recusa resolveOrderedGoalscorer quando selecao declara periodo especifico", () => {
    const jogadores = [
      { nome: "Erling Haaland", gols: 1, golsContra: 0, playerId: "p1", minutosJogados: 90 },
    ];
    const gols = [
      { nome: "Erling Haaland", playerId: "p1", minuto: "67", ordinal: 1 },
    ];
    const res = resolveOrderedGoalscorer({
      selecao: "Erling Haaland - 1st Half",
      mercado: "First Goalscorer",
      jogadores,
      gols,
    });
    expect(res).toEqual({ ok: false, reason: "mercado_sem_ordem" });
  });
});

/**
 * Quantidade de gols do jogador. O caso grave: "To Score 3+ Goals", "To Score
 * a Hat-trick" e "Haaland 3+" saíam WON com 1 gol, lidos como "marcar".
 */
describe("requiredPlayerGoals e N+ gols", () => {
  it.each([
    ["Anytime Goalscorer", "Haaland", 1],
    ["To Score 2+ Goals", "Haaland", 2],
    ["To Score 3+ Goals", "Haaland", 3],
    ["To Score a Hat-trick", "Haaland", 3],
    ["Hat Trick", "Haaland", 3],
    ["Anytime Goalscorer", "Haaland 3+", 3],
    ["Anytime Goalscorer", "Haaland 4+ gols", 4],
    ["Marcar 3 ou mais gols", "Haaland", 3],
    ["To Score 2 or More Goals", "Haaland", 2],
    ["Brace", "Haaland", 2],
    ["Bis", "Haaland", 2],
    ["Marcar pelo menos 2 gols", "Haaland", 2],
    ["Marcar no 1º Tempo", "Haaland", 1],
    ["First Goalscorer", "Haaland", 1],
  ] as const)("%s / %s pede %i gol(s)", (mercado, selecao, gols) => {
    expect(requiredPlayerGoals(mercado, selecao)).toBe(gols);
  });

  it.each([
    ["Anytime Goalscorer", "Haaland over 1.5"],
    ["Anytime Goalscorer", "Haaland dois gols"],
    ["To Score 2+ Goals", "Haaland 3+"],
    ["Anytime Goalscorer", "Haaland 9"],
  ])("grafia sem leitura segura (%s / %s) não vira marcar", (mercado, selecao) => {
    expect(requiredPlayerGoals(mercado, selecao)).toBeNull();
  });

  it("3+ e hat-trick com 1 ou 2 gols saem LOST; com 3 saem WON", () => {
    for (const [mercado, selecao] of [
      ["To Score 3+ Goals", "Erling Haaland"],
      ["To Score a Hat-trick", "Erling Haaland"],
      ["Anytime Goalscorer", "Erling Haaland 3+"],
    ] as const) {
      for (const [gols, status] of [[1, "LOST"], [2, "LOST"], [3, "WON"]] as const) {
        expect(resolveGoalscorer({ selecao, mercado, jogadores: [jogador("Erling Haaland", gols)] }), `${mercado} ${gols}`)
          .toMatchObject({ ok: true, status });
      }
    }
  });

  it("grafia desconhecida de gols vai para o operador", () => {
    expect(resolveGoalscorer({
      selecao: "Erling Haaland over 1.5", mercado: "Anytime Goalscorer", jogadores: [jogador("Erling Haaland", 2)],
    })).toEqual({ ok: false, reason: "quantidade_de_gols_desconhecida" });
  });

  it("o mercado de 3+ e o hat-trick são reconhecidos como gol de jogador", () => {
    for (const mercado of ["To Score 3+ Goals", "To Score a Hat-trick", "Hat-trick", "3+ Gols", "Bis"]) {
      expect(ehMercadoArtilheiro(mercado, "Haaland"), mercado).toBe(true);
    }
  });
});

/**
 * "Both Teams to Score" é o nome que a captura grava para Ambas Marcam, e o
 * placar é quem o responde. Gol de TIME não é pergunta sobre jogador.
 */
describe("mercado de gol de time não é artilheiro", () => {
  it.each([
    ["Both Teams to Score", "Yes"],
    ["Both Teams to Score", "No"],
    ["Home Team to Score", "Yes"],
    ["Away Team to Score", "No"],
    ["Team to Score", "Flamengo"],
    ["Home to Score", "Yes"],
    ["Away to Score", "Yes"],
    ["Both Teams Not to Score", "Yes"],
    ["Time da casa marcar", "Sim"],
  ])("%s / %s fica fora do artilheiro", (mercado, selecao) => {
    expect(ehMercadoArtilheiro(mercado, selecao)).toBe(false);
  });

  it.each([
    ["Primeiro Time a Marcar", "Flamengo"],
    ["Primeira Equipe a Marcar", "Flamengo"],
    ["Time a Marcar Primeiro", "Flamengo"],
    ["Último Time a Marcar", "Palmeiras"],
    ["First Team to Score", "Flamengo"],
  ])("%s / %s não é primeiro/último a marcar de jogador", (mercado, selecao) => {
    expect(orderedGoalscorerMarketOrder(mercado, selecao)).toBeNull();
  });

  it("Both Teams To Score do 1º tempo também fica fora do gol de jogador por tempo", () => {
    expect(ehMercadoArtilheiroPorTempo("Both Teams To Score - 1st Half", "Yes")).toBe(false);
  });

  it.each([
    ["Anytime Goalscorer", "Haaland"],
    ["To Score", "Haaland"],
    ["Player to Score", "Haaland"],
    ["Anytime To Score", "Haaland"],
    ["Any Time to Score", "Haaland"],
    ["Marcar a qualquer momento", "Haaland"],
  ])("%s continua artilheiro", (mercado, selecao) => {
    expect(ehMercadoArtilheiro(mercado, selecao)).toBe(true);
  });

  it("Primeiro/Último a Marcar continuam de jogador", () => {
    expect(orderedGoalscorerMarketOrder("Primeiro a Marcar", "Haaland")).toBe("first");
    expect(orderedGoalscorerMarketOrder("Último a Marcar", "Haaland")).toBe("last");
  });

  it("1st Half Goalscorer continua gol de jogador por tempo", () => {
    expect(ehMercadoArtilheiroPorTempo("1st Half Goalscorer", "Haaland")).toBe(true);
  });

  /**
   * O time citado é o do jogador ("Jogador da Equipe Visitante a Marcar"): a
   * pergunta continua sendo o gol dele, e o placar não a responde.
   */
  it.each([
    "Jogador da Equipe Visitante a Marcar a Qualquer Momento",
    "Jogador do Time da Casa Marcar a Qualquer Momento",
    "Anytime Goalscorer - Away Team to Score",
  ])("%s é artilheiro e liquida pelo gol do jogador", (mercado) => {
    expect(ehMercadoArtilheiro(mercado, "Haaland")).toBe(true);
    expect(resolveGoalscorer({ mercado, selecao: "Haaland", jogadores: [jogador("Erling Haaland", 1)] }))
      .toMatchObject({ ok: true, status: "WON" });
    expect(resolveGoalscorer({ mercado, selecao: "Haaland", jogadores: [jogador("Erling Haaland", 0)] }))
      .toMatchObject({ ok: true, status: "LOST" });
  });

  it("jogador do time a marcar no 1º tempo é gol de jogador por tempo", () => {
    expect(ehMercadoArtilheiroPorTempo("Jogador do Time da Casa a Marcar no 1º Tempo", "Haaland")).toBe(true);
  });

  it("primeiro jogador do time a marcar não é o primeiro gol do jogo", () => {
    // O primeiro gol do time pode ser o segundo da partida: sem contrato de ordem.
    expect(orderedGoalscorerMarketOrder("Primeiro Jogador do Time da Casa a Marcar", "Haaland")).toBeNull();
  });
});

/**
 * O resolvedor só sabe "marcou ou não". Gol de cabeça, de fora da área, nos
 * dois tempos, ou o gol combinado com assistência ou resultado é outra aposta:
 * liquidá-la pelo gol do jogador inverteria o resultado.
 */
describe("artilheiro com qualificador que a lista de jogadores não mede", () => {
  const semGolComAssistencias = [jogador("Cristaldo Franco", 0, { stats: { ASSISTS_GOAL: 2 } })];
  const tresGolsSemAssistencia = [jogador("Cristaldo Franco", 3, { stats: { ASSISTS_GOAL: 0 } })];
  const golsNoResumo = [
    { playerId: "CristaldoFranco", nome: "Cristaldo Franco", minuto: "12", ordinal: 1 },
    { playerId: "CristaldoFranco", nome: "Cristaldo Franco", minuto: "30", ordinal: 2 },
    { playerId: "CristaldoFranco", nome: "Cristaldo Franco", minuto: "80", ordinal: 3 },
  ];

  it.each([
    ["Marcar a Qualquer Momento ou Dar Assistência", "Franco Cristaldo"],
    ["Anytime Goalscorer or Assist", "Franco Cristaldo"],
    ["To Score or Assist", "Franco Cristaldo"],
    ["Marcar a Qualquer Momento e Dar Assistência", "Franco Cristaldo"],
    ["To Score a Header", "Franco Cristaldo"],
    ["To Score from Outside the Box", "Franco Cristaldo"],
    ["Marcar a Qualquer Momento - Fora da Área", "Franco Cristaldo"],
    ["To Score in Both Halves", "Franco Cristaldo"],
    ["To Score 1H/2H", "Franco Cristaldo"],
    ["1+ gol em cada tempo", "Franco Cristaldo"],
    ["To Score in Two Halves", "Franco Cristaldo"],
    ["To Score in 2 Halves", "Franco Cristaldo"],
    ["Marcar a Qualquer Momento em Cada Etapa", "Franco Cristaldo"],
    ["Goalscorer & Win", "Franco Cristaldo"],
    ["Anytime Goalscorer", "Franco Cristaldo ou Rick"],
  ])("%s / %s vai para o operador, com ou sem gol", (mercado, selecao) => {
    // Continua gol de jogador: o classificador de prop não pode pegá-lo.
    expect(ehMercadoArtilheiro(mercado, selecao)).toBe(true);
    for (const jogadores of [semGolComAssistencias, tresGolsSemAssistencia]) {
      expect(resolveGoalscorer({ mercado, selecao, jogadores }))
        .toEqual({ ok: false, reason: "qualificador_sem_contrato" });
    }
  });

  /**
   * O qualificador lê os dois tempos pelo mesmo vocabulário do período: a
   * captura avisa "Mercado não reconhecido" em toda grafia que a liquidação
   * manda ao dono.
   */
  it.each([
    ["To Score 1H/2H", "Haaland"],
    ["1+ gol em cada tempo", "Haaland"],
    ["Marcar em cada etapa", "Haaland"],
    ["Anytime Goalscorer", "Haaland - two halves"],
  ])("%s / %s é qualificador sem contrato", (mercado, selecao) => {
    expect(hasUnsupportedGoalQualifier(mercado, selecao)).toBe(true);
  });

  it("primeiro a marcar e gol por tempo recusam o mesmo qualificador", () => {
    expect(resolveOrderedGoalscorer({
      mercado: "First Goalscorer - Header", selecao: "Franco Cristaldo",
      jogadores: tresGolsSemAssistencia, gols: golsNoResumo,
    })).toEqual({ ok: false, reason: "qualificador_sem_contrato" });
    expect(resolvePeriodGoalscorer({
      mercado: "1st Half Goalscorer or Assist", selecao: "Franco Cristaldo",
      jogadores: tresGolsSemAssistencia, gols: golsNoResumo, periodo: "HT",
    })).toEqual({ ok: false, reason: "qualificador_sem_contrato" });
  });

  it.each([
    ["Anytime Goalscorer", "Franco Cristaldo", "WON"],
    ["To Score 2 or More Goals", "Franco Cristaldo", "WON"],
    ["Marcar 3 ou mais gols", "Franco Cristaldo", "WON"],
    ["To Score 2+ Goals", "Franco Cristaldo", "WON"],
    ["Anytime Goalscorer", "Franco Cristaldo 4+", "LOST"],
    ["Marcar a qualquer momento", "Franco Cristaldo - Sim", "WON"],
  ] as const)("controle: %s / %s continua liquidando (%s)", (mercado, selecao, status) => {
    expect(resolveGoalscorer({ mercado, selecao, jogadores: tresGolsSemAssistencia }))
      .toMatchObject({ ok: true, status });
  });

  /**
   * "Sobrenome E." é a grafia do próprio FlashScore, e a extração copia o nome
   * letra por letra: a inicial não é o conectivo "e", nem "Or" (nome) é "ou".
   */
  describe("inicial e nome que parecem conectivo", () => {
    const partida = [
      jogador("Haaland Erling", 1, { nomeCurto: "Haaland E.", titular: true }),
      jogador("Dasa Or", 0, { nomeCurto: "Dasa O.", titular: true }),
    ];
    const primeiroGol = [{ playerId: "HaalandErling", nome: "Haaland Erling", minuto: "12", ordinal: 1 }];

    it.each([
      ["E. Haaland", "WON"],
      ["Haaland E.", "WON"],
      ["Or Dasa", "LOST"],
    ] as const)("%s liquida no artilheiro, no primeiro a marcar e no gol por tempo (%s)", (selecao, status) => {
      expect(resolveGoalscorer({ mercado: "Anytime Goalscorer", selecao, jogadores: partida }))
        .toMatchObject({ ok: true, status });
      expect(resolveOrderedGoalscorer({ mercado: "First Goalscorer", selecao, jogadores: partida, gols: primeiroGol }))
        .toMatchObject({ ok: true, status });
      expect(resolvePeriodGoalscorer({
        mercado: "1st Half Goalscorer", selecao, jogadores: partida, gols: primeiroGol, periodo: "HT",
      })).toMatchObject({ ok: true, status });
    });

    it.each([
      "Haaland e Dasa",
      "Haaland E. & Dasa O.",
      "Haaland + Dasa",
    ])("dois jogadores na seleção (%s) continuam combinação", (selecao) => {
      expect(resolveGoalscorer({ mercado: "Anytime Goalscorer", selecao, jogadores: partida }))
        .toEqual({ ok: false, reason: "qualificador_sem_contrato" });
    });
  });
});
