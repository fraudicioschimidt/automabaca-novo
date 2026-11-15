import { describe, expect, it } from "vitest";
import { mensagemEsportePendente, sportPendingMessage } from "@/src/domain/sport-pending";
import { SPORT_AUTO_CONFIRM_MIN_CONFIDENCE } from "@/src/domain/sports/detect";

/**
 * O automático só confirma com 90 ou mais e sem outro esporte a partir de 70:
 * esporte errado contamina identidade e liquidação. A aposta que para precisa
 * chegar ao dono como aviso, com o motivo, em vez de esperar em silêncio na
 * caixa de ações.
 */
describe("aviso de esporte não confirmado", () => {
  const limiar = SPORT_AUTO_CONFIRM_MIN_CONFIDENCE;

  it("leva o que a busca achou, com o motivo de ter parado", () => {
    expect(mensagemEsportePendente({
      evento: "Larkhall Ath vs Hungerford Town",
      limiar,
      candidates: [{
        sport: "Soccer", confidence: 88, source: "WEB", country: "England",
        competition: "Southern Football League, Division One South",
        kickoffIso: "2026-09-16T18:45:00.000Z",
      }],
    })).toBe(
      "❓ Esporte a confirmar · Larkhall Ath vs Hungerford Town\n"
      + "A busca achou: Soccer · England · Southern Football League, Division One South · início 16/09 15:45\n"
      + "Certeza de 88%, e o automático só confirma a partir de 90%.\n"
      + "👉 Confirme o esporte na caixa de ações do painel.",
    );
  });

  it("diz qual fonte discorda, ou que a web não acrescentou nada", () => {
    const candidates = [{ sport: "Basketball", confidence: 95, source: "WEB", country: "Chile" }];
    expect(mensagemEsportePendente({
      evento: "A vs B", limiar, candidates,
      dissent: { sport: "Soccer", confidence: 80, source: "TEAM_ID", provider: "team_identity", strategy: "exact_local_identity" },
    })).toContain("Certeza de 95%, mas a identidade dos times aponta Soccer (80%).");
    expect(mensagemEsportePendente({ evento: "A vs B", limiar, candidates, reason: "web_without_detail" }))
      .toContain("Certeza de 95%, mas a busca na web não acrescentou competição, país nem horário ao que a aposta já dizia.");
  });

  it("a caixa de ações diz quem segurou a confirmação", () => {
    expect(sportPendingMessage({ reason: "post_dissent", dissent: { sport: "Soccer", confidence: 85, source: "LLM", fromPost: true } }))
      .toBe("A busca achou o jogo, mas a leitura da IA aponta Soccer (85%).");
    expect(sportPendingMessage({ reason: "candidate_dissent", dissent: { sport: "Soccer", confidence: 80, source: "TEAM_ID", provider: "team_identity" } }))
      .toBe("A busca achou o jogo, mas a identidade dos times aponta Soccer (80%): o automático espera mais evidência.");
    expect(sportPendingMessage({ reason: "strong_candidates_disagree", dissent: { sport: "Basketball", confidence: 95, source: "PROVIDER", provider: "pinnacle17" } }))
      .toBe("As fontes discordam: a Pinnacle17 aponta Basketball (95%).");
    expect(sportPendingMessage({ reason: "no_strong_candidate" })).toBeNull();
  });

  it("sem candidato nenhum, diz isso em vez de inventar detalhe", () => {
    expect(mensagemEsportePendente({ evento: "cuenca jrs vs san antonio", limiar, candidates: [] }))
      .toBe("❓ Esporte a confirmar · cuenca jrs vs san antonio\n"
        + "Nenhuma fonte achou este jogo.\n👉 Confirme o esporte na caixa de ações do painel.");
  });

  it("escolhe o candidato mais confiante e aguenta campo faltando", () => {
    const texto = mensagemEsportePendente({
      evento: "A vs B",
      limiar,
      candidates: [
        { sport: "Basketball", confidence: 70, source: "TEXT" },
        { sport: "Soccer", confidence: 88, source: "WEB", country: "Israel", competition: null },
      ],
    });
    expect(texto).toContain("A busca achou: Soccer · Israel\n");
    expect(texto).not.toContain("início");
    expect(texto).not.toContain("Basketball");
  });

  it("o limiar do texto é o mesmo do código — não há número solto", () => {
    expect(mensagemEsportePendente({ evento: "A vs B", limiar, candidates: [{ sport: "Soccer", confidence: 90, source: "WEB" }] }))
      .toContain(`o automático só confirma a partir de ${SPORT_AUTO_CONFIRM_MIN_CONFIDENCE}%`);
  });
});
