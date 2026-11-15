import { describe, expect, it } from "vitest";
import { hasBareSelectionOdd, isResultRecap, looksLikeChannelBetPost } from "@/src/services/capture/reading/noise-filter";

describe("isResultRecap", () => {
  it.each([
    "Resultado do dia\nCoquimbo vs Colo Colo\nODD 2.10\nStake 1u",
    "Coquimbo vs Colo Colo\nEntrada: Casa @2.10\n✅ GREEN",
    "Flamengo x Palmeiras\nRED ❌",
    "Green!",
    "Flamengo x Palmeiras\n✅",
    "Resultado: void",
  ])("balanço ou resultado: %j", (text) => {
    expect(isResultRecap(text)).toBe(true);
  });

  it.each([
    "✅ Entrada confirmada\nFlamengo x Palmeiras @1.90\n1u",
    "Green Bay Packers ML @1.80",
    "Red Bull Bragantino x Palmeiras\nCasa @2.00",
    "Red Star Belgrado ML",
    "Mercado: Resultado Final\nEntrada: Casa",
    "Win Alcaraz 1.90",
  ])("entrada, não resultado: %j", (text) => {
    expect(isResultRecap(text)).toBe(false);
  });
});

describe("isResultRecap: tip com confronto e odd", () => {
  const TIP = "Flamengo x Palmeiras\nOver 2.5 @1.90\n1u";

  it.each([
    "✅", "🟢🟢🟢", "🔴", "Anulada se empatar", "Void se empatar", "Reembolsada se 2 gols", "Cashout aos 70'",
    "Green 🙏", "Perdeu? Não dobra.", "Bateu a meta? Para.", "✅ Anulada em caso de empate",
  ])("enfeite, condição do mercado ou gestão não fazem da tip uma recapitulação: %j", (line) => {
    expect(isResultRecap(`${TIP}\n${line}`)).toBe(false);
    expect(isResultRecap(`${line}\n${TIP}`)).toBe(false);
  });

  it.each(["✅ GREEN", "GREEN", "Green!", "RED ❌", "❌", "Resultado: void", "Bateu ✅", "Anulada", "Meio green", "Cashout ✅", "Green do dia"])(
    "o resultado escrito continua barrando a tip repetida: %j",
    (line) => {
      expect(isResultRecap(`${TIP}\n${line}`)).toBe(true);
    },
  );

  it("sem cara de tip, o emoji de resultado sozinho ainda é recapitulação", () => {
    expect(isResultRecap("Flamengo x Palmeiras\nOver 2.5\n✅")).toBe(true);
    expect(isResultRecap("Over 2.5 @1.90\n🟢🟢🟢")).toBe(true);
  });
});

describe("looksLikeChannelBetPost", () => {
  it("aceita post de aposta (≥2 sinais) e rejeita ruído", () => {
    expect(
      looksLikeChannelBetPost("⚽ Santos x Grêmio\nEntrada: Over 2.5 @1.91\n1u"),
    ).toBe(true);
    expect(looksLikeChannelBetPost("Bom dia galera! 🌞")).toBe(false);
    expect(looksLikeChannelBetPost("")).toBe(false);
  });

  it("balanço do dia não é entrada", () => {
    expect(
      looksLikeChannelBetPost("📊 Resultado do dia: 3 greens @1.90, 1u cada ✅✅✅"),
    ).toBe(false);
  });

  it("aceita tip limpa com confronto e linha de mercado/odd sem rótulo", () => {
    expect(looksLikeChannelBetPost("Arsenal vs Chelsea\nOver 2.5 - 1.90")).toBe(true);
    expect(looksLikeChannelBetPost("Arsenal vs Chelsea\nResultado final: 2 - 1")).toBe(false);
  });

  /**
   * O rótulo de odd em PT é tão comum quanto `@` em canal brasileiro, e errar
   * aqui é perda SILENCIOSA de tip: o post morre em `nao_parece_aposta` sem
   * telemetria e sem alerta.
   */
  it.each(["Cotação: 1.90", "Cotacao 1.90", "Cota: 1.90", "Preço: 1.90"])(
    "reconhece rótulo PT de odd: %s",
    (linhaDaOdd) => {
      expect(looksLikeChannelBetPost(`Flamengo vs Palmeiras\nOver 2.5\n${linhaDaOdd}`)).toBe(true);
    },
  );

  it("assinatura de banca / SL não conta como confronto", () => {
    expect(
      looksLikeChannelBetPost("Staking Nicolas / SL\n\nSe voltar -1 @1.6 pode pegar"),
    ).toBe(false);
    expect(looksLikeChannelBetPost("Luis / SL\nmin 2,02")).toBe(false);
    expect(
      looksLikeChannelBetPost(
        "Tipster: Target\nJogo: Wolverhampton x Blackburn\nEntrada: Wolves O.1,5 cards\nODD: 1.76\nStake: 1.3u",
      ),
    ).toBe(true);
  });

  /**
   * Odd sem "@" nem rótulo no fim da linha da seleção. Canal de stake fixa
   * posta sem stake, e o post sem os dois sinais sumia em silêncio.
   */
  it.each([
    "Flamengo x Palmeiras\nAmbas marcam 1.85",
    "Sinner vs Alcaraz\nSinner vence 1.95",
    "Real Madrid x Barcelona\nReal Madrid -0.5 1,95",
    "Arsenal vs Chelsea\nMais de 2.5 gols 1.90",
    "Lakers x Celtics\nLakers ML - 2.10",
    "Corinthians x Santos\nEmpate 3.40",
  ])("odd nua na linha da seleção, com confronto, passa: %s", (text) => {
    expect(looksLikeChannelBetPost(text)).toBe(true);
  });

  it.each([
    ["horário no confronto", "Flamengo x Palmeiras 21.30\nAmbas marcam"],
    ["horário com palavra", "Flamengo x Palmeiras\nHoje às 21.30"],
    ["horário com dois-pontos", "Flamengo x Palmeiras\nInício 21:30"],
    ["data", "Flamengo x Palmeiras\nSábado 23.09"],
    ["placar", "Flamengo 2 x 1 Palmeiras\nJogo encerrado"],
    ["linha de total sem odd", "Flamengo x Palmeiras\nOver 2.5"],
    ["linha de escanteios sem odd", "Flamengo x Palmeiras\nEscanteios 9.5"],
    ["linha de handicap com sinal", "Flamengo x Palmeiras\nPalmeiras +1.5"],
    ["recapitulação com resultado", "Flamengo x Palmeiras\nAmbas marcam 1.85 ✅"],
    ["recapitulação com green", "Flamengo x Palmeiras\nGreen! Ambas marcam 1.85"],
    ["odd nua sem confronto", "Bom dia! A média de hoje foi 1.85"],
    ["número fora da faixa de odd", "Flamengo x Palmeiras\nPúblico esperado 45.50"],
  ])("odd nua não conta em %s", (_caso, text) => {
    expect(looksLikeChannelBetPost(text)).toBe(false);
  });

  it.each([
    ["horário depois da competição", "Flamengo x Palmeiras\nBrasileirão 21.30"],
    ["rótulo de stake", "Flamengo x Palmeiras\nStake 2.00"],
    ["unidade", "Flamengo x Palmeiras\nUnidades 1.50"],
  ])("odd nua não conta com %s", (_caso, text) => {
    expect(hasBareSelectionOdd(text)).toBe(false);
  });

  it("rótulo de odd não promove balanço nem texto sem confronto", () => {
    // O anti-sinal continua vencendo, e um número solto com rótulo ainda é 1
    // sinal só — o filtro exige DOIS.
    expect(looksLikeChannelBetPost("Resultado do dia: cotação média 1.90")).toBe(false);
    expect(looksLikeChannelBetPost("A cotação do dólar hoje: 5.40")).toBe(false);
  });
});


it.each(["Cash-out", "Cash out", "Cash-out parcial realizado", "Cash out total realizado com lucro de 0,3u"])("não recaptura aviso de encerramento: %s", (line) => {
  const text = `Flamengo x Palmeiras\nOver 2.5 @1.90\n1u\n${line}`;
  expect(isResultRecap(text)).toBe(true);
  expect(looksLikeChannelBetPost(text)).toBe(false);
});
it.each(["Cash-out aos 70 minutos", "Cash out se fizer gol", "Cash-out parcial quando atingir 1u", "Cashout disponível: 0,8u", "Cash out oferecido: 0,8u", "Cashout parcial disponível: 0,8u"])("mantém instrução futura de gestão: %s", (line) => {
  expect(isResultRecap(`Flamengo x Palmeiras\nOver 2.5 @1.90\n1u\n${line}`)).toBe(false);
});
