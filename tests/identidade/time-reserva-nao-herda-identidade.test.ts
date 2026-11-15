import { describe, expect, it } from "vitest";
import {
  canonicalizeTeamName,
  hasProtectedTeamCategoryConflict,
  orientedTeamPairHasReserveSuffixConflict,
  reserveSuffixMismatch,
  teamIdentityCategoryConflict,
  teamSimilarity,
} from "@/src/domain/text";
import { providerTeamCategoryCompatible } from "@/src/services/bets/sport-resolution/provider-shared";

/**
 * Portão: time FEMININO, RESERVA ou de BASE herdando a identidade do principal.
 *
 * O FlashScore é o liquidador primário de resultado. Quem decide contra qual
 * partida a aposta liquida é o alias de time da identidade — então um alias
 * errado não erra "um nome": erra o PLACAR.
 *
 * `protectedCategoriesMismatch` é o desenho: token que distingue times
 * diferentes derruba a similaridade para 0,35 e o vínculo é recusado. O que
 * este arquivo fixa é o VOCABULÁRIO, na grafia que o FlashScore usa:
 *
 * - `W`. O provider escreve `Lyon W (Fra)` no time e "club friendly women" na
 *   competição; "women" por extenso não basta.
 * - Dígito solto. `River Plate 2` joga a reserve league argentina, `Viking 2` a
 *   3ª divisão norueguesa, `Atlanta United 2` a MLS Next Pro. Preservar o
 *   número na canonicalização não é proteger: o containment ignora a diferença.
 * - `Akatemia`. Finlandês para academy, e a Finlândia está na cobertura.
 *
 * Esses vínculos nascem `AUTO` com confiança alta; a competição de cada par é a
 * prova independente de que o time é outro.
 */

/**
 * Pares REAIS da produção, com a competição que prova serem times distintos.
 * Separados por MECANISMO, porque a defesa de cada um mora em lugar diferente
 * — e o alcance é a razão (ver `reserveSuffixMismatch`).
 */
const POR_VOCABULARIO: ReadonlyArray<readonly [string, string, string]> = [
  ["Lyon W (Fra)", "lyon", "world: club friendly women"],
  ["Tottenham W (Eng)", "Tottenham", "world: club friendly women"],
  ["Werder Bremen W (Ger)", "Werder Bremen", "world: club friendly women"],
  ["Nice W (Fra)", "Nice", "world: club friendly women"],
  ["Auxerre W (Fra)", "Auxerre", "world: club friendly women"],
  ["Albacete W (Esp)", "Albacete", "world: club friendly women"],
  ["Athletic Bilbao W (Esp)", "Athletic Bilbao", "world: club friendly women"],
  ["KuPS Akatemia", "KuPS", "finland: ykkonen"],
  ["SJK", "SJK Akatemia", "finland: veikkausliiga"],
];

const POR_SUFIXO_NUMERICO: ReadonlyArray<readonly [string, string, string]> = [
  ["River Plate 2", "River Plate", "argentina: reserve league - clausura"],
  ["Independiente 2", "Independiente", "argentina: reserve league - clausura"],
  ["Newells Old Boys 2", "Newells Old Boys", "argentina: reserve league - clausura"],
  ["Aldosivi 2", "Aldosivi", "argentina: reserve league - clausura"],
  ["Viking 2", "Viking", "norway: division 3 - group 4"],
  ["Asane 2", "asane", "norway: division 3 - group 3"],
  ["Atlanta United 2", "Atlanta Utd", "usa: mls next pro"],
  ["Kauno Zalgiris 2", "Kauno Zalgiris", "lithuania: i lyga"],
  ["Hegelmann Litauen 2", "Hegelmann", "lithuania: i lyga"],
  ["Sport Huancayo 2", "Sport Huancayo", "peru: liga 2"],
];

/**
 * O contra-peso, e é ele que impede a guarda de virar regressão: exigir núcleo
 * de tokens IGUAL reprovaria muitos aliases FlashScore CERTOS (`Torino (Ita)`,
 * `L.R. Vicenza`, `Mainz 05`, `Whitby` → `Whitby Town`). Containment carrega o
 * aprendizado legítimo; barra o token protegido.
 */
const VINCULOS_CERTOS: ReadonlyArray<readonly [string, string]> = [
  ["Torino (Ita)", "Torino"],
  ["Udinese (Ita)", "Udinese"],
  ["L.R. Vicenza", "vicenza"],
  ["Whitby", "Whitby Town"],
  ["Valur", "Valur Reykjavik"],
  ["West Brom (Eng)", "West Brom"],
  ["Villarreal B (Esp)", "Villarreal B"],
  ["Arsenal Sarandi", "Arsenal de Sarandi"],
  // Ano de FUNDAÇÃO não é sufixo de reserva — o canonicalizador promete que
  // continua compatível, e é por isso que o dígito protegido é só 2–9.
  ["Mainz 05", "Mainz"],
  ["Schalke 04", "Schalke"],
];

describe("reserva, base e feminino não herdam a identidade do principal", () => {
  it.each(POR_VOCABULARIO)("%s não é %s (%s)", (providerName, canonico, competicao) => {
    expect(competicao.length).toBeGreaterThan(0);
    expect(
      hasProtectedTeamCategoryConflict(providerName, canonico),
      `"${providerName}" e "${canonico}" são times diferentes`,
    ).toBe(true);
    // 0,35 é o teto que o mismatch impõe; qualquer limiar de aprendizado fica acima.
    expect(teamSimilarity(providerName, canonico)).toBeLessThan(0.5);
  });

  it.each(POR_SUFIXO_NUMERICO)("%s não é %s (%s)", (providerName, canonico, competicao) => {
    expect(competicao.length).toBeGreaterThan(0);
    expect(
      reserveSuffixMismatch(canonicalizeTeamName(providerName), canonicalizeTeamName(canonico)),
      `"${providerName}" e "${canonico}" são times diferentes`,
    ).toBe(true);
  });

  it.each(VINCULOS_CERTOS)("%s continua sendo %s", (providerName, canonico) => {
    expect(hasProtectedTeamCategoryConflict(providerName, canonico)).toBe(false);
    expect(teamSimilarity(providerName, canonico)).toBeGreaterThanOrEqual(0.6);
  });

  /**
   * O vocabulário é a defesa; sem esta prova ele pode ser podado por engano e o
   * portão acima continua verde só porque os pares da tabela são poucos.
   */
  it("a grafia do provider está no vocabulário protegido, não só a forma extensa", () => {
    for (const [abreviada, extensa] of [["W", "women"], ["Akatemia", "academy"]] as const) {
      expect(
        hasProtectedTeamCategoryConflict(`Time ${abreviada}`, "Time"),
        `"${abreviada}" (grafia do FlashScore para ${extensa}) precisa distinguir times`,
      ).toBe(true);
    }
    for (const digito of [2, 3, 4, 5, 6, 7, 8, 9]) {
      expect(
        reserveSuffixMismatch(`time ${digito}`, "time"),
        `sufixo "${digito}" é time reserva em vários feeds`,
      ).toBe(true);
    }
  });

  /**
   * ALCANCE — o dígito NÃO pode virar token protegido global. `teamSimilarity`
   * é aplicada a texto que não é só nome de time, e a seleção da aposta
   * ("Canada Over 1.5") canonicaliza para "canada over 1 5": proteger o dígito
   * ali quebra, entre outras, a liquidação asiática e a equivalência de preço.
   * Esta é a linha que impede a guarda de voltar pelo caminho errado.
   */
  it("o dígito não contamina a comparação de seleção com nome de time", () => {
    expect(hasProtectedTeamCategoryConflict("Canada Over 1.5", "Canada")).toBe(false);
    expect(teamSimilarity("Canada Over 1.5", "Canada")).toBeGreaterThanOrEqual(0.9);
    expect(hasProtectedTeamCategoryConflict("Time 2", "Time")).toBe(false);
    // `5` de "Over 1.5" é dígito 2–9. Por isso `teamIdentityCategoryConflict`
    // é só nome-contra-nome (learn/matcher), nunca seleção-contra-time.
    expect(teamIdentityCategoryConflict("Canada Over 1.5", "Canada")).toBe(true);
    expect(teamIdentityCategoryConflict("Time 2", "Time")).toBe(true);
    expect(teamIdentityCategoryConflict("River Plate 2", "River Plate")).toBe(true);
    expect(teamIdentityCategoryConflict("Atlanta United 2", "Atlanta United")).toBe(true);
    expect(orientedTeamPairHasReserveSuffixConflict({
      providerHome: "River Plate 2",
      providerAway: "Boca Juniors 2",
      localHome: "River Plate",
      localAway: "Boca Juniors",
      swapped: false,
    })).toBe(true);
    expect(orientedTeamPairHasReserveSuffixConflict({
      providerHome: "River Plate",
      providerAway: "Boca Juniors",
      localHome: "River Plate",
      localAway: "Boca Juniors",
      swapped: false,
    })).toBe(false);
  });

  it("sport-resolution recusa sufixo numérico, não só token protegido", () => {
    expect(providerTeamCategoryCompatible({
      localHome: "River Plate",
      localAway: "Independiente",
      providerHome: "River Plate",
      providerAway: "Independiente 2",
      swapped: false,
    })).toBe(false);
    expect(providerTeamCategoryCompatible({
      localHome: "River Plate",
      localAway: "Independiente",
      providerHome: "River Plate",
      providerAway: "Independiente",
      swapped: false,
    })).toBe(true);
  });
});
