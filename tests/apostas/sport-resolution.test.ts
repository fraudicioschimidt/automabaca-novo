import { beforeEach, describe, expect, it, vi } from "vitest";

const teamCandidates = vi.hoisted(() => ({ find: vi.fn(async () => [] as Array<{ sport: string; confidence: number; source: string }>) }));
vi.mock("@/src/services/bets/sport-resolution/team-candidates", () => ({
  findTeamIdentitySportCandidates: teamCandidates.find,
}));
import { canonicalSport } from "@/src/domain/sports/registry";
import { detectSportFromText, llmSportDecision, SPORT_AUTO_CONFIRM_MIN_CONFIDENCE, SPORT_RESOLVER_VERSION, UNKNOWN_SPORT } from "@/src/domain/sports/detect";
import {
  guardIdentityCandidate,
  postSignals,
  refutingPostSports,
  resolveSportForCapture,
  resolveSportForCaptureAsync,
  sportStoredValue,
} from "@/src/services/bets/sport-resolution/capture";
import { candidateHints, chooseSportCandidate, LOCAL_IDENTITY_CANDIDATE_CONFIDENCE, sportResolutionWindowOpen } from "@/src/services/bets/sport-resolution/decision";
import { sportResolutionRetryDelaySeconds } from "@/src/jobs/sport-resolution-jobs";
import { canSearchSportOnWeb, nextWebSportSearchAt, webSportSearchTurn } from "@/src/domain/sport-resolution-retry";
import { earlySportResolutionResult } from "@/src/services/bets/sport-resolution/resolve";
import { SportResolutionStatus } from "@/src/generated/prisma/enums";
import { mapLlmBetToParsed, mapLlmBetToParsedList } from "@/src/services/capture/reading/extraction-mapping";
import { enrichParsedBetFromCaption } from "@/src/services/capture/preparation/parse-caption-enrich";
import type { ParsedBetPost } from "@/src/domain/bet-capture";
import { parseUniversalBetPost } from "@/src/domain/parse-bet-post";

const NOW = new Date("2026-07-23T18:00:00Z");

describe("sport resolution", () => {
  it("aposta removida não entra no resolvedor", () => {
    expect(earlySportResolutionResult({
      bet: {
        deletedAt: new Date("2026-08-14T15:52:45Z"),
        esporte: "Unknown",
        data: new Date("2026-08-14T15:51:44Z"),
        kickoffInferido: true,
        sportResolutionStatus: SportResolutionStatus.PENDING,
      },
      betId: "6e10e4cb-68af-43af-baba-6ce8b07f3d00",
      now: new Date("2026-08-14T15:53:23Z"),
      force: false,
    })).toMatchObject({ status: "ignored", reason: "missing_or_deleted" });
  });

  it("mantém a resolução aberta por sete dias após o kickoff", () => {
    const kickoff = new Date("2026-07-23T18:00:00Z");
    expect(sportResolutionWindowOpen({
      kickoff,
      kickoffInferido: false,
      now: new Date("2026-07-30T17:59:59Z"),
    })).toBe(true);
    expect(sportResolutionWindowOpen({
      kickoff,
      kickoffInferido: false,
      now: new Date("2026-07-30T18:00:01Z"),
    })).toBe(false);
  });

  it("usa retries rápidos e depois 2/2h durante 24h", () => {
    expect([0, 1, 2, 3, 14, 15].map(sportResolutionRetryDelaySeconds)).toEqual([
      30,
      120,
      1_800,
      7_200,
      7_200,
      null,
    ]);
  });

  describe("vezes da busca web, contadas do kickoff", () => {
    const kickoff = new Date("2026-07-25T20:00:00Z");
    const at = (msBeforeKickoff: number) => new Date(kickoff.getTime() - msBeforeKickoff);
    const turn = (attempt: number, now: Date, kickoffInferido = false) => webSportSearchTurn({ attempt, kickoff, kickoffInferido, now });

    it("primeira na tentativa 1; depois com menos de 3 h e com menos de 45 min", () => {
      expect(turn(0, at(2 * 86_400_000))).toBeNull();
      expect(turn(1, at(2 * 86_400_000))).toBe("first");
      expect(turn(7, at(3 * 3_600_000 + 1))).toBe("first");
      expect(turn(7, at(3 * 3_600_000))).toBe("pre_3h");
      expect(turn(8, at(45 * 60_000))).toBe("pre_45m");
      expect(turn(9, at(-3_600_000))).toBe("pre_45m");
      // Kickoff inferido não tem relógio: só a primeira.
      expect(turn(9, at(10 * 60_000), true)).toBe("first");
    });

    it("a vez gasta não volta; a próxima abre no horário do kickoff", () => {
      const base = { continuation: 0, outsideWindow: false, capacityDeferred: false };
      expect(canSearchSportOnWeb({ ...base, turn: "first", spent: [] })).toBe(true);
      expect(canSearchSportOnWeb({ ...base, turn: "first", spent: ["first"] })).toBe(false);
      expect(canSearchSportOnWeb({ ...base, turn: "pre_3h", spent: ["first"] })).toBe(true);
      expect(canSearchSportOnWeb({ ...base, turn: null, spent: [] })).toBe(false);
      expect(canSearchSportOnWeb({ ...base, turn: null, spent: [], force: true })).toBe(true);
      expect(canSearchSportOnWeb({ ...base, turn: "first", spent: [], outsideWindow: true, force: true })).toBe(false);

      const now = at(86_400_000);
      expect(nextWebSportSearchAt({ kickoff, kickoffInferido: false, now, spent: ["first"] })).toEqual(at(3 * 3_600_000));
      expect(nextWebSportSearchAt({ kickoff, kickoffInferido: false, now: at(2 * 3_600_000), spent: ["first", "pre_3h"] })).toEqual(at(45 * 60_000));
      expect(nextWebSportSearchAt({ kickoff, kickoffInferido: false, now: at(10 * 60_000), spent: ["pre_45m"] })).toBeNull();
      expect(nextWebSportSearchAt({ kickoff, kickoffInferido: true, now, spent: [] })).toBeNull();
    });

    it("com capacidade esgotada, a web espera a última retomada da tentativa", () => {
      const deferred = { turn: "first" as const, spent: [], continuation: 0, outsideWindow: false, capacityDeferred: true };
      expect(canSearchSportOnWeb(deferred)).toBe(false);
      expect(canSearchSportOnWeb({ ...deferred, continuation: 3 })).toBe(true);
    });
  });

  it.each([
    ["🏀 Leones Quilpué vs Universidad de Concepcion", "Basketball"],
    ["🎾 Alcaraz vs Sinner", "Tennis"],
    ["⚽ Flamengo vs Palmeiras", "Soccer"],
    ["🏐 Brasil vs Italia", "Volleyball"],
    ["🏒 Rangers vs Bruins", "Hockey"],
    ["NFL: Chiefs vs Bills", "American Football"],
    ["Futebol americano: Chiefs vs Bills", "American Football"],
    ["MLB: Yankees vs Red Sox", "Baseball"],
    ["VCT Valorant: Alpha vs Bravo", "eSports"],
    ["Copa do Brasil: Flamengo vs Palmeiras", "Soccer"],
    ["Brasileirão: Flamengo vs Palmeiras", "Soccer"],
    ["Ligue 1: PSG vs Lyon", "Soccer"],
    ["Europa League: Roma vs Porto", "Soccer"],
    ["Primeira Liga: Porto vs Benfica", "Soccer"],
    ["EFL Championship: Leeds vs Coventry", "Soccer"],
    ["Asian Handicap Corners\nAtletico Bucaramanga -1", "Soccer"],
    ["Total (Corners) – Match\nOver 9.5", "Soccer"],
    ["Total (Bookings) – Match\nUnder 4.5", "Soccer"],
    ["Both Teams Cards – Match", "Soccer"],
    ["Chutes a Gol - Mais de 4.5", "Soccer"],
    ["Player Rebounds Over 8.5", "Basketball"],
    ["Total de Rebotes - Mais de 11.5", "Basketball"],
    ["Tocos do Jogador - Mais de 1.5", "Basketball"],
    ["Cestas de 3: Mais de 4.5", "Basketball"],
    ["Touchdowns: Mais de 1.5", "American Football"],
    ["Passing Yards: Over 245.5", "American Football"],
    ["Home Runs: Mais de 0.5", "Baseball"],
    ["Strikeouts: Over 6.5", "Baseball"],
    ["Tie Break no 1º Set: Sim", "Tennis"],
  ])("confirma sinais determinísticos: %s", (text, expected) => {
    expect(detectSportFromText(text)).toMatchObject({
      status: "CONFIRMED",
      sport: expected,
      confidence: 95,
    });
  });

  it.each([
    // Futebol americano, futebol australiano e polo aquático também são jogados em quartos.
    "Chiefs x Bills\nChiefs -3.5 no 1º quarto @1.90",
    "Chiefs -3.5 1st Quarter",
    "Collingwood x Carlton\nCollingwood -10.5 1st quarter",
    "Brasil x Hungria\nBrasil vence o quarto 2",
    // "3 pontos" solto é spread de NFL ou stake, não cesta de três.
    "Chiefs x Bills\nChiefs -3 pontos @1.90",
    "Flamengo x Palmeiras\nOver 2.5 gols @1.85\nStake: 3 pts",
  ])("quarto e \"3 pontos\" soltos não provam basquete: %s", (text) => {
    expect(detectSportFromText(text).sport).not.toBe("Basketball");
    // A leitura da IA sem prova no texto continua valendo, em vez de perder para o "quarto".
    const decision = resolveSportForCapture({
      caption: text,
      bet: {
        evento: "Kansas City Chiefs vs Buffalo Bills", esporte: "American Football", competicao: "", pais: "",
        mercado: "Handicap", selecao: "Kansas City Chiefs -3.5", odds: 1.9, stake: 1, data: NOW, casaDeAposta: "",
        sportResolution: llmSportDecision({ sport: "American Football", confidence: 0.85 }),
      },
    });
    expect(decision.sport).not.toBe("Basketball");
  });

  it.each([
    "Over 8.5 rebotes",
    "Arremessos de 3 pontos: Mais de 2.5",
    "Cestas de 3 pontos: Mais de 4.5",
  ])("o vocabulário só do basquete continua provando basquete: %s", (text) => {
    expect(detectSportFromText(text)).toMatchObject({ status: "CONFIRMED", sport: "Basketball", confidence: 95 });
  });

  it("não gera falso positivo para modalidades vizinhas em termos ambíguos", () => {
    // "triplo" sozinho não deve marcar Basketball (ex: bilhete triplo em futebol)
    expect(detectSportFromText("Bilhete Triplo para hoje: time A + time B + time C").sport).not.toBe("Basketball");
    // "innings" não deve marcar Baseball em críquete
    expect(detectSportFromText("1st Innings Runs: Over 150.5").sport).not.toBe("Baseball");
    // "field goals" não deve marcar American Football em basquete
    expect(detectSportFromText("Field Goals Made: Over 8.5").sport).not.toBe("American Football");
  });

  it("aceita aliases canônicos em espanhol sem inventar esporte desconhecido", () => {
    expect(canonicalSport("fútbol")).toBe("Soccer");
    expect(canonicalSport("baloncesto")).toBe("Basketball");
    expect(canonicalSport("basket")).toBe("Basketball");
    expect(canonicalSport("ajedrez")).toBeNull();
  });

  it("não converte ausência de evidência silenciosamente em Soccer", () => {
    const decision = detectSportFromText(
      "Leones Quilpué vs Universidad de Concepcion\nPara Ganhar\n1.83",
    );
    expect(decision).toMatchObject({
      status: "PENDING",
      sport: null,
      confidence: 0,
    });
    expect(sportStoredValue(decision)).toBe(UNKNOWN_SPORT);
  });

  it("mantém conflito em vez de escolher uma modalidade", () => {
    expect(detectSportFromText("🏀 partida da Premier League")).toMatchObject({
      status: "CONFLICT",
      sport: null,
    });
  });

  it("respeita o esporte qualificado da Champions League", () => {
    expect(detectSportFromText("Champions League de Vôlei")).toMatchObject({
      status: "CONFIRMED",
      sport: "Volleyball",
    });
    expect(detectSportFromText("Champions League de Basquete")).toMatchObject({
      status: "CONFIRMED",
      sport: "Basketball",
    });
  });

  /**
   * Estas modalidades compartilham palavra ou liga com outro esporte. O desfecho
   * certo é a modalidade CERTA, e o guarda de desambiguação é o que impede o
   * sinal do esporte vizinho de disparar junto e transformar a resposta em
   * CONFLICT.
   */
  it("modalidades novas resolvem para si mesmas, não para quem compartilha a palavra", () => {
    const casos = [
      ["Liga Nacional de Futsal", "Futsal"],
      ["Futsal Premier League", "Futsal"],
      ["Champions League de Futsal", "Futsal"],
      ["Handball EHF Champions League", "Handball"],
      ["Handebol - Brasil x França", "Handball"],
      ["Premier League Rugby", "Rugby"],
      ["Six Nations - Irlanda x França", "Rugby"],
      ["Darts Premier League", "Darts"],
      ["PDC World Championship", "Darts"],
      ["Snooker Premier League", "Snooker"],
      ["Sinuca - O'Sullivan x Trump", "Snooker"],
      ["Vôlei de Praia - Duda / Ana Patricia", "Beach Volleyball"],
      ["Beach Volleyball World Tour", "Beach Volleyball"],
      ["🏐 Beach Volleyball World Tour", "Beach Volleyball"],
      ["Tênis de Mesa - Hugo Calderano", "Table Tennis"],
      ["Table Tennis Challenger Series", "Table Tennis"],
      ["Críquete - IPL Final", "Cricket"],
      ["Críquete - Indian Premier League", "Cricket"],
      ["Indian Premier League\nMumbai Indians x Chennai Super Kings", "Cricket"],
      ["Caribbean Premier League - Trinbago x Guyana", "Cricket"],
      ["Lanka Premier League - Jaffna x Kandy", "Cricket"],
      ["UFC 300 - Pereira x Hill", "MMA"],
      ["Boxe - Canelo x Bivol", "Boxing"],
      ["Golfe - PGA Championship", "Golf"],
    ] as const;
    for (const [text, sport] of casos) {
      expect(detectSportFromText(text), text).toMatchObject({
        status: "CONFIRMED",
        sport,
      });
    }
  });

  it("variantes ainda SEM contrato continuam pendentes", () => {
    for (const text of [
      "Beach Soccer FIFA",
      "Beach Soccer World Cup",
      "Futebol de Areia",
      "Field Hockey",
      "Grass Hockey",
      "Hockey sobre grama",
      "Hockey de grama",
      "Basquete 3x3 - Brasil x EUA",
      "3x3 Basketball - Brasil x EUA",
      "Hóquei em Patins - Porto x Benfica",
      "Roller Hockey Championship",
      "Rink Hockey Championship",
      "Futebol Society - Liga Fut7",
    ]) {
      expect(detectSportFromText(text), text).toMatchObject({
        status: "PENDING",
        sport: null,
      });
    }
  });

  it("mantém futebol gaélico, tênis adaptado e esportes virtuais pendentes", () => {
    for (const text of [
      "Futebol Gaélico - All Ireland",
      "Gaelic Football Championship",
      "Tênis em Cadeira de Rodas",
      "Wheelchair Tennis Open",
      "Hóquei sobre Grama - Holanda x Bélgica",
      "Hóquei de Grama - Holanda x Bélgica",
      "Futebol Virtual - Liga 3min",
      "Virtual Soccer Champions Cup",
      "Basquete Virtual - Liga 4x8min",
      "Virtual Basketball League",
      "Tênis Virtual - Open Sim",
      "Virtual Tennis Open",
    ]) {
      expect(detectSportFromText(text), text).toMatchObject({
        status: "PENDING",
        sport: null,
      });
    }
  });

  it("ambas marcam existe no hóquei: o mercado não prova futebol", () => {
    for (const text of [
      "Ambas Equipes Marcam: Sim",
      "Rangers x Bruins\nAmbas marcam - Sim @1.55",
      "CSKA x Spartak\nBTTS Sim",
      "Both Teams to Score - Yes",
    ]) {
      expect(detectSportFromText(text), text).toMatchObject({ status: "PENDING", sport: null });
    }
    expect(detectSportFromText("🏒 Rangers x Bruins\nAmbas marcam - Sim")).toMatchObject({ status: "CONFIRMED", sport: "Hockey" });
    expect(detectSportFromText("Brasileirão\nAmbas marcam - Sim")).toMatchObject({ status: "CONFIRMED", sport: "Soccer" });
  });

  it("Bangladesh Premier League nomeou a liga de futebol e a de críquete: não prova nenhuma", () => {
    for (const text of ["Bangladesh Premier League - Abahani x Mohammedan", "Bangladesh Premier League - Rangpur x Sylhet"]) {
      expect(detectSportFromText(text), text).toMatchObject({ status: "PENDING", sport: null });
    }
  });

  it("a IA que leu hóquei não é derrubada pelo mercado ambas marcam", async () => {
    const decision = await resolveSportForCaptureAsync({
      caption: "Rangers x Bruins\nAmbas marcam - Sim @1.55",
      bet: {
        evento: "Rangers vs Bruins",
        esporte: "Hockey",
        competicao: "",
        pais: "",
        mercado: "Both Teams to Score",
        selecao: "Yes",
        odds: 1.55,
        stake: 1,
        data: NOW,
        casaDeAposta: "",
        sportResolution: llmSportDecision({ sport: "Hockey", confidence: 0.9 }),
      },
    });
    expect(decision).toMatchObject({ status: "PENDING", sport: "Hockey", source: "LLM" });
  });

  it("não lê Hockey Club no nome do time como modalidade", () => {
    expect(
      detectSportFromText("Hockey Club de Lujan vs San Martin\nPremier League"),
    ).toMatchObject({ status: "CONFIRMED", sport: "Soccer" });
  });

  it("LLM isolada nunca ultrapassa confiança 85", () => {
    expect(
      llmSportDecision({
        sport: "Basketball",
        confidence: 1,
        evidenceText: "aparência da quadra",
      }),
    ).toMatchObject({
      status: "PENDING",
      sport: "Basketball",
      confidence: 85,
    });
  });

  it("WEB no limiar confirma com detalhe acrescentado pela fonte; LLM 85 permanece pendente", () => {
    expect(SPORT_AUTO_CONFIRM_MIN_CONFIDENCE).toBe(90);
    const web = {
      sport: "Basketball" as const, confidence: SPORT_AUTO_CONFIRM_MIN_CONFIDENCE, source: "WEB" as const,
      provider: "web" as const, strategy: "grounded_search", competition: "LNB", country: "Chile",
    };
    expect(chooseSportCandidate([web], { bet: { competicao: "", pais: "" } })).toMatchObject({
      conflict: false,
      reason: "confirmed",
      candidate: { sport: "Basketball", source: "WEB", confidence: SPORT_AUTO_CONFIRM_MIN_CONFIDENCE },
    });
    const llm = llmSportDecision({ sport: "Basketball", confidence: 1 });
    expect(llm).toMatchObject({ status: "PENDING", confidence: 85 });
    expect(llm.confidence).toBeLessThan(SPORT_AUTO_CONFIRM_MIN_CONFIDENCE);
    expect(chooseSportCandidate([{ sport: "Basketball", confidence: llm.confidence, source: "LLM" }]))
      .toMatchObject({ candidate: null, conflict: false, reason: "no_strong_candidate" });
  });

  it("Gemini sem esporte registra Unknown pendente no caso Leones", () => {
    const parsed = mapLlmBetToParsed(
      {
        isBet: true,
        evento: "Leones Quilpue vs Universidad de Concepcion",
        esporte: "",
        competicao: "Chile - LNB",
        mercado: "Moneyline",
        selecao: "Universidad de Concepcion",
        odds: 1.83,
        stake: 0.5,
        dataTexto: "23/07 21:30",
      },
      NOW,
    );
    expect(parsed).toMatchObject({
      esporte: "Unknown",
      sportResolution: {
        status: "PENDING",
        sport: null,
      },
    });
  });

  it("evidência explícita do texto vence o palpite fraco do parser", () => {
    const decision = resolveSportForCapture({
      caption: "🏀 Chile LNB",
      bet: {
        evento: "Leones Quilpue vs Universidad de Concepcion",
        esporte: "Soccer",
        competicao: "Chile LNB",
        pais: "Chile",
        mercado: "Moneyline",
        selecao: "Universidad de Concepcion",
        odds: 1.83,
        stake: 0.5,
        data: NOW,
        casaDeAposta: "",
        sportResolution: llmSportDecision({
          sport: "Soccer",
          confidence: 0.8,
        }),
      },
    });
    expect(decision).toMatchObject({
      status: "CONFIRMED",
      sport: "Basketball",
      source: "EMOJI",
    });
  });

  it("a competição em linha própria não vira futebol diante do emoji de basquete", () => {
    const decision = resolveSportForCapture({
      caption: "🏀 Virtus x Olimpia\nOver 160.5",
      bet: {
        evento: "Virtus Bologna vs Olimpia Milano",
        esporte: "Basketball",
        competicao: "Serie A",
        pais: "Italy",
        mercado: "Total",
        selecao: "Over 160.5",
        odds: 1.9,
        stake: 1,
        data: NOW,
        casaDeAposta: "",
        sportResolution: llmSportDecision({ sport: "Basketball", confidence: 0.9 }),
      },
    });
    expect(decision).toMatchObject({ status: "CONFIRMED", sport: "Basketball" });
  });

  describe("lote misto: cada item lê a legenda inteira do post", () => {
    const multiple = "Múltipla do dia\n🏀 Lakers x Celtics - Over 220.5\nJuventus x Milan (Serie A) - Over 2.5";
    const item = (evento: string, competicao: string, selecao: string, sport: string, evidenceText?: string): ParsedBetPost => ({
      evento, esporte: sport, competicao, pais: "", mercado: "Total", selecao, odds: 1.9, stake: 1, data: NOW, casaDeAposta: "",
      sportResolution: llmSportDecision({ sport, confidence: 0.9, evidenceText }),
    });
    const capture = (bet: ParsedBetPost, caption: string) =>
      resolveSportForCaptureAsync({ bet: enrichParsedBetFromCaption(bet, caption), caption, channelSports: [] });

    it("a linha de tênis não leva o item de futebol da Série A", async () => {
      const caption = "🎾 Sinner x Alcaraz - Sinner ML @1.80\nFlamengo x Botafogo - Série A - Over 2.5 @1.90";
      expect(await capture(item("Flamengo vs Botafogo", "Série A", "Over 2.5", "Soccer", "Flamengo x Botafogo - Série A"), caption))
        .toMatchObject({ status: "CONFLICT", sport: null });
      expect(await capture(item("Sinner vs Alcaraz", "", "Sinner ML", "Tennis"), caption))
        .toMatchObject({ status: "CONFIRMED", sport: "Tennis" });
    });

    it("pela leitura do lote, o item de outro jogo não herda o esporte da raiz", async () => {
      const caption = "🎾 Sinner x Alcaraz - Sinner ML @1.80 1u\nFlamengo x Botafogo - Série A - Over 2.5 @1.90 1u";
      const sinner = { evento: "Sinner vs Alcaraz", mercado: "Moneyline", selecao: "Sinner", odds: 1.8, stake: 1 };
      // A primeira simples também preenche a raiz, com a leitura do esporte dela.
      const lote = (flamengo: Record<string, unknown>) => ({
        isBet: true, ticketType: "singles", visibleBetCount: 2, ...sinner,
        esporte: "Tennis", sportConfidence: 0.95, sportEvidenceText: "🎾",
        items: [sinner, { evento: "Flamengo vs Botafogo", competicao: "Série A", mercado: "Total", selecao: "Over 2.5", odds: 1.9, stake: 1, ...flamengo }],
      });
      for (const flamengo of [{}, { esporte: "" }, { esporte: "Soccer" }]) {
        const [first, second] = mapLlmBetToParsedList(lote(flamengo), NOW) ?? [];
        if (!first || !second) throw new Error("o lote não virou duas apostas");
        expect(await capture(first, caption), JSON.stringify(flamengo)).toMatchObject({ status: "CONFIRMED", sport: "Tennis" });
        expect(await capture(second, caption), JSON.stringify(flamengo)).toMatchObject({ status: "CONFLICT", sport: null });
      }
    });

    it("sem a leitura da IA (regra local), o emoji decorativo não confirma outra modalidade", async () => {
      const caption = "🎮 Jogo do dia: Juventus x Milan - Serie A\nOver 2.5 @1.90\n1u";
      const parsed = parseUniversalBetPost(caption, { now: NOW });
      if (!parsed.ok) throw new Error(`regra local não leu: ${parsed.missing.join(", ")}`);
      expect(await capture(parsed.bet, caption)).toMatchObject({ status: "CONFLICT", sport: null });
    });

    it("o item lido como futebol fica em conflito, e o de basquete confirma", async () => {
      expect(await capture(item("Juventus vs Milan", "Serie A", "Over 2.5", "Soccer"), multiple))
        .toMatchObject({ status: "CONFLICT", sport: null });
      expect(await capture(item("Juventus vs Milan", "Serie A", "Over 2.5", "Soccer", "Juventus x Milan (Serie A)"), multiple))
        .toMatchObject({ status: "CONFLICT", sport: null });
      expect(await capture(item("Lakers vs Celtics", "NBA", "Over 220.5", "Basketball"), multiple))
        .toMatchObject({ status: "CONFIRMED", sport: "Basketball" });
    });

    it("a liga só no campo do item também segura o emoji do outro jogo", async () => {
      const caption = "Múltipla do dia\n🏀 Lakers x Celtics - Over 220.5\nJuventus x Milan - Over 2.5";
      expect(await capture(item("Juventus vs Milan", "Serie A", "Over 2.5", "Soccer"), caption))
        .toMatchObject({ status: "CONFLICT", sport: null });
    });

    it("o rodapé de outro canal não confirma a outra modalidade", async () => {
      for (const [caption, bet] of [
        ["Serie A - Juventus x Milan\nOver 2.5\n\nVIP de basquete: t.me/canal", item("Juventus vs Milan", "Serie A", "Over 2.5", "Soccer")],
        ["La Liga - Real Madrid x Barcelona\nAmbas marcam\n\n🏀 Entre no canal da NBA", item("Real Madrid vs Barcelona", "La Liga", "Sim", "Soccer")],
      ] as const) {
        expect(await capture(bet, caption), caption).toMatchObject({ status: "CONFLICT", sport: null });
      }
    });
  });

  describe("liga compartilhada ('Serie A', 'La Liga', 'Premier League') no canal vários", () => {
    const item = (evento: string, competicao: string, mercado: string, selecao: string, sport?: string, evidenceText?: string): ParsedBetPost => ({
      evento, esporte: sport ?? UNKNOWN_SPORT, competicao, pais: "", mercado, selecao, odds: 1.9, stake: 1, data: NOW, casaDeAposta: "",
      ...(sport ? { sportResolution: llmSportDecision({ sport, confidence: 0.9, evidenceText }) } : {}),
    });
    const capture = (bet: ParsedBetPost, caption: string) =>
      resolveSportForCaptureAsync({ bet: enrichParsedBetFromCaption(bet, caption), caption, channelSports: [] });

    it.each([
      ["Serie A - Virtus x Olimpia\nTotal de Pontos Mais de 158.5", item("Virtus vs Olimpia", "Serie A", "Total de Pontos", "Over 158.5", "Basketball")],
      ["Itália - Serie A\nVirtus x Olimpia - Over 158.5", item("Virtus vs Olimpia", "Serie A", "Total", "Over 158.5", "Basketball", "Itália - Serie A")],
      ["La Liga - Real Madrid x Barcelona\nReal Madrid -4.5", item("Real Madrid vs Barcelona", "La Liga", "Handicap", "Real Madrid -4.5", "Basketball")],
      ["Champions League - Perugia x Trento\nMais de 3.5 sets", item("Perugia vs Trento", "Champions League", "Total", "Over 3.5 sets", "Volleyball")],
      ["Premier League\nLittler x Humphries - Littler ML", item("Littler vs Humphries", "Premier League", "Moneyline", "Littler", "Darts")],
    ])("a IA leu outra modalidade: %j não vira futebol", async (caption, bet) => {
      const decision = await capture(bet, caption);
      expect(decision.sport, caption).not.toBe("Soccer");
      expect(decision.status, caption).not.toBe("CONFIRMED");
    });

    it("lida como futebol, a Serie A continua futebol", async () => {
      const caption = "Serie A - Juventus x Milan\nOver 2.5";
      expect(await capture(item("Juventus vs Milan", "Serie A", "Total", "Over 2.5", "Soccer"), caption))
        .toMatchObject({ status: "CONFIRMED", sport: "Soccer" });
    });

    it("sem a leitura da IA (regra local), a linha fora da escala do futebol segura a liga compartilhada", async () => {
      for (const caption of ["Virtus x Olimpia - Serie A\nOver 158.5 @1.90\n1u", "La Liga - Real Madrid x Barcelona\nReal Madrid -8.5 @1.90\n1u"]) {
        const parsed = parseUniversalBetPost(caption, { now: NOW });
        if (!parsed.ok) throw new Error(`regra local não leu: ${parsed.missing.join(", ")}`);
        expect(await capture(parsed.bet, caption), caption).toMatchObject({ status: "PENDING", sport: null });
      }
      // A linha de futebol, ou a liga só do futebol, confirmam como antes.
      for (const caption of ["Juventus x Milan - Serie A\nOver 2.5 @1.90\n1u", "Flamengo x Palmeiras - Brasileirão\nOver 158.5 @1.90\n1u"]) {
        const parsed = parseUniversalBetPost(caption, { now: NOW });
        if (!parsed.ok) throw new Error(`regra local não leu: ${parsed.missing.join(", ")}`);
        expect(await capture(parsed.bet, caption), caption).toMatchObject({ status: "CONFIRMED", sport: "Soccer" });
      }
    });
  });

  it("dois providers concordando elevam a confirmação para 98", () => {
    expect(
      chooseSportCandidate([
        {
          sport: "Basketball",
          confidence: 95,
          source: "PROVIDER",
          provider: "flashscore",
        },
        {
          sport: "Basketball",
          confidence: 95,
          source: "PROVIDER",
          provider: "pinnacle17",
        },
      ]),
    ).toMatchObject({
      conflict: false,
      candidate: {
        sport: "Basketball",
        confidence: 98,
        strategy: "two_provider_agreement",
      },
    });
  });

  it("providers fortes discordando produzem conflito", () => {
    expect(
      chooseSportCandidate([
        {
          sport: "Soccer",
          confidence: 95,
          source: "PROVIDER",
          provider: "flashscore",
        },
        {
          sport: "Basketball",
          confidence: 95,
          source: "PROVIDER",
          provider: "pinnacle17",
        },
      ]),
    ).toMatchObject({ candidate: null, conflict: true, reason: "strong_candidates_disagree" });
  });

  it("resolveSportForCaptureAsync preserva decisão síncrona se confirmada", async () => {
    const decision = await resolveSportForCaptureAsync({
      caption: "⚽ Brasil Serie A",
      bet: {
        evento: "Flamengo vs Vasco",
        esporte: "Soccer",
        competicao: "Serie A",
        pais: "Brazil",
        mercado: "Moneyline",
        selecao: "Flamengo",
        odds: 1.83,
        stake: 0.5,
        data: NOW,
        casaDeAposta: "",
        sportResolution: {
          sport: "Soccer",
          status: "CONFIRMED",
          confidence: 95,
          source: "TEXT",
          evidence: [],
          resolverVersion: 5,
        },
      },
    });
    expect(decision.status).toBe("CONFIRMED");
    expect(decision.sport).toBe("Soccer");
    expect(sportStoredValue(decision)).toBe("Soccer");
  });

  it("llmSportDecision promove para CONFIRMED quando suportado por evidência textual comprovada", () => {
    const basketballDecision = llmSportDecision({
      sport: "Basketball",
      confidence: 0.9,
      evidenceText: "Basquete",
    });
    expect(basketballDecision).toMatchObject({
      status: "CONFIRMED",
      sport: "Basketball",
      confidence: 95,
      source: "TEXT",
      resolverVersion: SPORT_RESOLVER_VERSION,
    });

    const tennisDecision = llmSportDecision({
      sport: "Tennis",
      confidence: 0.9,
      evidenceText: "Tênis",
    });
    expect(tennisDecision).toMatchObject({
      status: "CONFIRMED",
      sport: "Tennis",
      confidence: 95,
      source: "TEXT",
      resolverVersion: SPORT_RESOLVER_VERSION,
    });
  });

  it("llmSportDecision promove para CONFIRMED com evidência de competição", () => {
    const decision = llmSportDecision({
      sport: "Basketball",
      confidence: 0.9,
      evidenceText: "NBA",
    });
    expect(decision).toMatchObject({
      status: "CONFIRMED",
      sport: "Basketball",
      confidence: 95,
      source: "COMPETITION",
      resolverVersion: SPORT_RESOLVER_VERSION,
    });
  });

  it("llmSportDecision: a liga compartilhada da evidência cede à modalidade lida", () => {
    expect(llmSportDecision({ sport: "Basketball", confidence: 0.9, evidenceText: "🏀 Serie A" }))
      .toMatchObject({ status: "CONFIRMED", sport: "Basketball", source: "EMOJI" });
    // Lida como futebol, a mesma evidência continua contraditória.
    expect(llmSportDecision({ sport: "Soccer", confidence: 0.9, evidenceText: "🏀 Serie A" }))
      .toMatchObject({ status: "PENDING", sport: "Soccer" });
  });

  it("llmSportDecision acusa CONFLICT quando a evidência textual contradiz a modalidade", () => {
    const decision = llmSportDecision({
      sport: "Basketball",
      confidence: 0.9,
      evidenceText: "Futebol",
    });
    expect(decision.status).toBe("CONFLICT");
  });

  it("llmSportDecision permanece PENDING quando a evidência for genérica ou ausente", () => {
    const withoutEvidence = llmSportDecision({
      sport: "Soccer",
      confidence: 0.85,
    });
    expect(withoutEvidence).toMatchObject({
      status: "PENDING",
      sport: "Soccer",
      confidence: 85,
      source: "LLM",
    });

    const genericEvidence = llmSportDecision({
      sport: "Soccer",
      confidence: 0.85,
      evidenceText: "Over 2.5",
    });
    expect(genericEvidence).toMatchObject({
      status: "PENDING",
      sport: "Soccer",
      confidence: 85,
      source: "LLM",
    });
  });

  it("resolveSportForCapture confirma instantaneamente aposta vinda de OCR com evidência comprovada", () => {
    const ocrDecision = llmSportDecision({
      sport: "Basketball",
      confidence: 0.95,
      evidenceText: "Basquete",
    });
    const decision = resolveSportForCapture({
      caption: "", // Sem legenda
      bet: {
        evento: "Boston Celtics vs Miami Heat",
        esporte: "Basketball",
        competicao: "NBA",
        pais: "USA",
        mercado: "Moneyline",
        selecao: "Boston Celtics",
        odds: 1.90,
        stake: 1,
        data: NOW,
        casaDeAposta: "",
        sportResolution: ocrDecision,
      },
    });
    expect(decision.status).toBe("CONFIRMED");
    expect(decision.sport).toBe("Basketball");
    expect(decision.confidence).toBeGreaterThanOrEqual(92);
  });
});

describe("critério único da confirmação automática", () => {
  const flashscore = (sport: "Basketball" | "Soccer", confidence = 95) =>
    ({ sport, confidence, source: "PROVIDER" as const, provider: "flashscore" as const, matchId: `fs-${sport}` });
  const pinnacle17 = (sport: "Basketball" | "Soccer", confidence: number) =>
    ({ sport, confidence, source: "PROVIDER" as const, provider: "pinnacle17" as const, matchId: `p17-${sport}` });
  /** A identidade dos times como a base a entrega: pista, abaixo de 70. */
  const namesOnly = (sport: "Basketball" | "Soccer") =>
    ({ sport, confidence: LOCAL_IDENTITY_CANDIDATE_CONFIDENCE, source: "TEAM_ID" as const, provider: "team_identity" as const, strategy: "exact_local_identity" });
  const web = (sport: "Basketball" | "Soccer", confidence: number, detail: { competition?: string; country?: string } = { country: "Chile" }) =>
    ({ sport, confidence, source: "WEB" as const, provider: "web" as const, strategy: "grounded_search", ...detail });
  const bet = { competicao: "", pais: "", kickoffInferido: false };

  it("confirma com 90 e nenhum outro esporte a partir de 70", () => {
    expect(chooseSportCandidate([pinnacle17("Basketball", 90)])).toMatchObject({ reason: "confirmed", candidate: { sport: "Basketball" } });
    expect(chooseSportCandidate([pinnacle17("Basketball", 95), { ...namesOnly("Soccer"), confidence: 69 }], { bet }))
      .toMatchObject({ reason: "confirmed", candidate: { sport: "Basketball" } });
  });

  it("dois esportes com 90 ou mais: conflito", () => {
    expect(chooseSportCandidate([flashscore("Soccer"), pinnacle17("Basketball", 90)])).toMatchObject({
      candidate: null, conflict: true, reason: "strong_candidates_disagree",
    });
  });

  it("outro esporte abaixo de 90 vindo de candidato deixa pendente, e diz quem discorda", () => {
    expect(chooseSportCandidate([web("Basketball", 95), pinnacle17("Soccer", 80)], { bet })).toMatchObject({
      candidate: null, conflict: false, reason: "candidate_dissent",
      dissent: { sport: "Soccer", confidence: 80, provider: "pinnacle17", fromPost: false },
    });
  });

  it("outro esporte abaixo de 90 vindo da leitura do post: conflito para o dono", () => {
    const postSignals = [{ sport: "Soccer" as const, confidence: 85, source: "LLM" }];
    expect(chooseSportCandidate([flashscore("Basketball")], { postSignals })).toMatchObject({
      candidate: null, conflict: true, reason: "post_dissent",
      dissent: { sport: "Soccer", confidence: 85, source: "LLM", fromPost: true },
    });
    // Abaixo de 70 a leitura não segura nada.
    expect(chooseSportCandidate([flashscore("Basketball")], { postSignals: [{ ...postSignals[0]!, confidence: 60 }] }))
      .toMatchObject({ reason: "confirmed" });
  });

  it("a IA que o texto desmente não discorda", () => {
    const postSignals = [
      { sport: "Basketball" as const, confidence: 95, source: "EMOJI" },
      { sport: "Soccer" as const, confidence: 85, source: "LLM" },
    ];
    expect(chooseSportCandidate([flashscore("Basketball")], { postSignals })).toMatchObject({ reason: "confirmed" });
    // O texto dos termos da aposta também desmente a IA.
    const marketText = { sport: "Basketball" as const, confidence: 95, source: "TEXT" as const, strategy: "deterministic_market_text" };
    expect(chooseSportCandidate([marketText], { postSignals: [postSignals[1]!] })).toMatchObject({ reason: "confirmed" });
  });

  it("evidência desmentida não vota, e a identidade só de nomes cala quando o catálogo acha o jogo", () => {
    const contradicted = { ...namesOnly("Soccer"), strategy: "external_id_pair_contradicted" };
    expect(chooseSportCandidate([web("Basketball", 95), contradicted], { bet })).toMatchObject({ reason: "confirmed" });
    expect(chooseSportCandidate([flashscore("Basketball"), namesOnly("Soccer")])).toMatchObject({ reason: "confirmed" });
    const homonyms = (["Soccer", "Basketball"] as const).map((sport) => ({ ...namesOnly(sport), strategy: "homonym_pair" }));
    expect(chooseSportCandidate([pinnacle17("Basketball", 95), ...homonyms])).toMatchObject({ reason: "confirmed" });
    // A web não acha o jogo por catálogo, mas a identidade, abaixo de 70, não a segura:
    // Flamengo e Botafogo também têm basquete.
    expect(chooseSportCandidate([web("Basketball", 95), namesOnly("Soccer")], { bet })).toMatchObject({ reason: "confirmed", candidate: { sport: "Basketball" } });
  });

  it("leitura fraca da IA não desmente a identidade dos times; texto e IA a partir de 70 desmentem", () => {
    const identity = { ...namesOnly("Soccer"), strategy: "external_id_pair" };
    const evento = { evento: "Flamengo vs Corinthians" };
    const read = (source: string, confidence: number) => refutingPostSports(postSignals([{ source, sport: "Basketball", confidence }]));
    expect(read("LLM", 40)).toEqual([]);
    expect(guardIdentityCandidate(identity, evento, read("LLM", 40))).toEqual(identity);
    expect(guardIdentityCandidate(identity, evento, read("LLM", 70))).toMatchObject({ strategy: "external_id_pair_contradicted" });
    expect(guardIdentityCandidate(identity, evento, read("TEXT", 95))).toMatchObject({ strategy: "external_id_pair_contradicted" });
    // A identidade não confirma a dela, nem com id externo.
    expect(chooseSportCandidate([identity])).toMatchObject({ candidate: null, reason: "no_strong_candidate" });
  });

  it("a linha e o placar fora da escala do esporte desmentem a identidade dos times", () => {
    const identity = { ...namesOnly("Soccer"), strategy: "external_id_pair" };
    const flamengo = { evento: "Botafogo vs Flamengo", mercado: "Handicap", selecao: "Flamengo +8.5" };
    expect(guardIdentityCandidate(identity, flamengo, [])).toMatchObject({ strategy: "external_id_pair_contradicted" });
    expect(guardIdentityCandidate(identity, { ...flamengo, selecao: "Flamengo -1.5" }, [])).toEqual(identity);
    // Escanteio tem outra escala.
    expect(guardIdentityCandidate(identity, { ...flamengo, mercado: "Handicap Escanteios", selecao: "Flamengo -6.5 escanteios" }, [])).toEqual(identity);
    const moneyline = { evento: "Botafogo vs Flamengo", mercado: "Moneyline", selecao: "Flamengo" };
    expect(guardIdentityCandidate(identity, { ...moneyline, scores: [{ home: 77, away: 97 }] }, []))
      .toMatchObject({ strategy: "external_id_pair_contradicted" });
    expect(guardIdentityCandidate(identity, { ...moneyline, scores: [{ home: 2, away: 1 }] }, [])).toEqual(identity);
    const basketball = { ...identity, sport: "Basketball" as const };
    expect(guardIdentityCandidate(basketball, { ...flamengo, scores: [{ home: 77, away: 97 }] }, [])).toEqual(basketball);
    expect(guardIdentityCandidate(basketball, { ...flamengo, selecao: "Flamengo +75.5" }, []))
      .toMatchObject({ strategy: "external_id_pair_contradicted" });
    // O "1" do período não é a linha do total.
    const total = { evento: "Botafogo vs Flamengo", mercado: "Total" };
    expect(guardIdentityCandidate(basketball, { ...total, selecao: "1T Over 110.5" }, [])).toEqual(basketball);
    expect(guardIdentityCandidate(basketball, { ...total, selecao: "1T Over 9.5" }, []))
      .toMatchObject({ strategy: "external_id_pair_contradicted" });
  });

  it("o resultado que não confirmou traz o candidato forte que foi segurado", () => {
    expect(chooseSportCandidate([web("Basketball", 95), pinnacle17("Soccer", 80)], { bet }))
      .toMatchObject({ reason: "candidate_dissent", leader: { sport: "Basketball", provider: "web" } });
    expect(chooseSportCandidate([web("Basketball", 95, { competition: "LNB", country: "Chile" })], { bet: { competicao: "LNB", pais: "Chile" } }))
      .toMatchObject({ reason: "web_without_detail", leader: { sport: "Basketball" } });
  });

  it("a web só confirma com detalhe que a fonte acrescentou", () => {
    const echo = web("Basketball", 95, { competition: "LNB", country: "Chile" });
    const asked = { competicao: "LNB", pais: "Chile", kickoffInferido: false };
    expect(chooseSportCandidate([echo], { bet: asked })).toMatchObject({ candidate: null, conflict: false, reason: "web_without_detail" });
    expect(chooseSportCandidate([echo], { bet: { ...asked, pais: "" } })).toMatchObject({ reason: "confirmed" });
    expect(chooseSportCandidate([{ ...echo, kickoffIso: "2026-07-24T00:30:00Z" }], { bet: { ...asked, kickoffInferido: true } }))
      .toMatchObject({ reason: "confirmed" });
    // Tradução do que a aposta já dizia não é detalhe novo.
    expect(chooseSportCandidate([web("Basketball", 95, { competition: "Liga ACB", country: "Spain" })], { bet: { competicao: "Liga ACB", pais: "Espanha" } }))
      .toMatchObject({ reason: "web_without_detail" });
    // Sem os termos da aposta não há como conferir: não confirma.
    expect(chooseSportCandidate([web("Basketball", 95)])).toMatchObject({ reason: "web_without_detail" });
  });
});

describe("candidateHints", () => {
  it("cantos ordenam a busca, sem apagar evidência de outra modalidade", () => {
    expect(candidateHints({ mercado: "Moneyline", selecao: "Over 9Cantos", esporte: "Hockey" })).toEqual(["Soccer", "Hockey"]);
  });

  it("ambas marcam põe o futebol na busca, depois do esporte que a leitura deu", () => {
    for (const mercado of ["Both Teams to Score", "Ambos Marcam", "Gol/Gol", "Ambas as equipes marcam", "Both Score"]) {
      expect(candidateHints({ mercado, selecao: "Sim" }), mercado).toEqual(["Soccer"]);
    }
    expect(candidateHints({ mercado: "Ambas Marcam", selecao: "Sim", esporte: "Hockey" })).toEqual(["Hockey", "Soccer"]);
  });
});

describe("esportes do canal na captura", () => {
  const bet = {
    evento: "Mogi vs Franca",
    esporte: "Unknown",
    competicao: "",
    pais: "",
    mercado: "Total",
    selecao: "Over 150.5",
    odds: 1.9,
    stake: 1,
    data: NOW,
    casaDeAposta: "",
  };
  const capture = (channelSports: string[], overrides: Partial<typeof bet> = {}, caption = "Over 150.5") =>
    resolveSportForCaptureAsync({ bet: { ...bet, ...overrides }, caption, channelSports });
  /** Os dois nomes com id externo no futebol: a base diz "Soccer". */
  const soccerIdentity = [{ sport: "Soccer", confidence: 60, source: "TEAM_ID", provider: "team_identity", strategy: "external_id_pair" }];

  beforeEach(() => {
    teamCandidates.find.mockReset().mockResolvedValue([]);
  });

  it("canal com um esporte só confirma a aposta sem evidência nele", async () => {
    expect(await capture(["Basketball"])).toMatchObject({ status: "CONFIRMED", sport: "Basketball", source: "CHANNEL", confidence: 95 });
    expect(await capture([])).toMatchObject({ status: "PENDING", sport: null });
  });

  it("evidência forte de outro esporte vira conflito", async () => {
    expect(await capture(["Basketball"], { evento: "Flamengo vs Vasco" }, "⚽ Flamengo vs Vasco"))
      .toMatchObject({ status: "CONFLICT", sport: null });
  });

  it("a identidade dos times não confirma nem discorda do canal", async () => {
    teamCandidates.find.mockResolvedValue(soccerIdentity);
    const moneyline = { mercado: "Moneyline", selecao: "Mogi" };
    // Sem canal, a identidade nem é consultada: quem confirma é o resolvedor, pelo jogo.
    expect(await capture([], moneyline, "Mogi")).toMatchObject({ status: "PENDING", sport: null });
    expect(teamCandidates.find).not.toHaveBeenCalled();
    // O dono disse que o canal é de basquete: os nomes no futebol não desmentem.
    expect(await capture(["Basketball"], moneyline, "Mogi")).toMatchObject({ status: "CONFIRMED", sport: "Basketball", source: "CHANNEL" });
    // Vários esportes no canal: a identidade não escolhe o futebol sozinha.
    expect(await capture(["Soccer", "Basketball"], moneyline, "Mogi")).toMatchObject({ status: "PENDING", sport: null });
  });

  it("no canal só de futebol, o handicap ou o placar fora da escala discordam: o canal não confirma", async () => {
    const botafogo = { evento: "Botafogo vs Flamengo", mercado: "Handicap", selecao: "Flamengo +8.5" };
    expect(await capture(["Soccer"], botafogo, "Flamengo +8.5")).toMatchObject({ status: "PENDING", sport: null });
    expect(await capture(["Soccer"], { ...botafogo, selecao: "Flamengo -1.5" }, "Flamengo -1.5")).toMatchObject({ status: "CONFIRMED", sport: "Soccer" });
    const moneyline = { ...botafogo, mercado: "Moneyline", selecao: "Flamengo" };
    expect(await capture(["Soccer"], moneyline, "Botafogo 77x97 Flamengo\nFlamengo ML")).toMatchObject({ status: "PENDING", sport: null });
    expect(await capture(["Soccer"], { ...moneyline, liveScoreHome: 77, liveScoreAway: 97 } as Partial<typeof bet>, "Flamengo ML"))
      .toMatchObject({ status: "PENDING", sport: null });
    // Placar de futebol, ou escrito fora dos nomes (data, horário), não discorda.
    expect(await capture(["Soccer"], moneyline, "Botafogo 2x1 Flamengo\nFlamengo ML")).toMatchObject({ status: "CONFIRMED", sport: "Soccer" });
    expect(await capture(["Soccer"], moneyline, "Botafogo x Flamengo 20-30\nFlamengo ML")).toMatchObject({ status: "CONFIRMED", sport: "Soccer" });
    expect(await capture(["Basketball"], moneyline, "Botafogo 77x97 Flamengo\nFlamengo ML")).toMatchObject({ status: "CONFIRMED", sport: "Basketball" });
  });

  it("time homônimo: os esportes do canal escolhem quando sobra um", async () => {
    const homonyms = [
      { sport: "Soccer", confidence: 80, source: "TEAM_ID", strategy: "homonym_pair" },
      { sport: "Basketball", confidence: 80, source: "TEAM_ID", strategy: "homonym_pair" },
    ];
    teamCandidates.find.mockResolvedValue(homonyms);
    expect(await capture(["Basketball", "Volleyball"])).toMatchObject({ status: "CONFIRMED", sport: "Basketball", source: "CHANNEL" });
    // Os dois dentro do canal: nada a escolher.
    expect(await capture(["Basketball", "Soccer"], { mercado: "Moneyline", selecao: "Mogi" }, "Mogi")).toMatchObject({ status: "PENDING", sport: null });
    // A linha de 150.5 desmente o futebol: sobra o basquete.
    expect(await capture(["Basketball", "Soccer"])).toMatchObject({ status: "CONFIRMED", sport: "Basketball", source: "CHANNEL" });
    // O placar escrito entre os nomes também.
    expect(await capture(["Basketball", "Soccer"], { mercado: "Moneyline", selecao: "Mogi" }, "Mogi 77x97 Franca\nMogi"))
      .toMatchObject({ status: "CONFIRMED", sport: "Basketball", source: "CHANNEL" });
  });

  it("vários esportes restringem os candidatos sem confirmar sozinhos", async () => {
    expect(await capture(["Basketball", "Volleyball"])).toMatchObject({ status: "PENDING", sport: null });
    // Palpite fraco fora da lista do canal contradiz o dono: conflito.
    expect(await capture(["Basketball", "Volleyball"], { esporte: "Tennis" })).toMatchObject({ status: "CONFLICT", sport: null });
  });

  it("IA com outro esporte, mesmo abaixo do limiar, vira conflito no canal de um esporte só", async () => {
    const llmSoccer = { sport: "Soccer" as const, status: "PENDING" as const, confidence: 70, source: "LLM" as const,
      evidence: [{ source: "LLM" as const, sport: "Soccer" as const, confidence: 70, value: "classificação estruturada" }], resolverVersion: SPORT_RESOLVER_VERSION };
    expect(await resolveSportForCaptureAsync({ bet: { ...bet, sportResolution: llmSoccer }, caption: "Over 150.5", channelSports: ["Basketball"] }))
      .toMatchObject({ status: "CONFLICT", sport: null });
  });

  it.each([
    [["Basketball"], "Over 15.5", "CONFLICT"],
    [["Basketball"], "U3.5", "CONFLICT"],
    [["Basketball"], "O2.5", "CONFLICT"],
    [["Basketball"], "Over 150.5", "CONFIRMED"],
    [["Soccer"], "Over 150.5", "CONFLICT"],
    [["Soccer"], "Over 2.5", "CONFIRMED"],
  ])("canal %j com total %s: %s", async (channelSports, selecao, status) => {
    expect(await capture(channelSports, { selecao })).toMatchObject({ status });
  });

  it.each(["1T Over 110.5", "1º Tempo Mais de 110.5", "Q1 Over 54.5"])(
    "período escrito antes da linha ('%s') não é a linha do total: o canal de basquete confirma",
    async (selecao) => {
      expect(await capture(["Basketball"], { selecao }, selecao)).toMatchObject({ status: "CONFIRMED", sport: "Basketball", source: "CHANNEL" });
    },
  );
});
