import { describe, expect, it } from "vitest";
import { formatSpDateTime, formatSpDayMonth, spDayKey } from "@/src/domain/dates";

/**
 * Data exibida é lida no relógio do operador, não no de QUEM RENDERIZA.
 *
 * A convenção do projeto é armazenar UTC, exibir em America/Sao_Paulo e nunca
 * converter fuso ad-hoc em componente/handler. `d.getDate()/d.getMonth()` leem
 * o fuso do processo: a VPS roda em UTC, o dono lê no navegador em São Paulo
 * (UTC−3).
 *
 * Duas consequências, as duas silenciosas:
 *
 * 1. DIA ERRADO. Post das 21h30 de São Paulo é 00h30 UTC do dia seguinte, e a
 *    janela exibida descreveria uma noite do dia 18 como sendo do 19.
 *    Canal brasileiro posta à noite: é a faixa mais provável, não a rara.
 * 2. HIDRATAÇÃO DIVERGENTE. O mesmo componente escrevia um dia no SSR (UTC) e
 *    outro na hidratação (SP), sem erro visível — o React troca o texto e segue.
 */

describe("toda data exibida usa o fuso do operador", () => {
  it("os testes rodam em UTC, como a VPS: fuso local no lugar do de São Paulo erraria o dia", () => {
    // Guarda do `TZ: "UTC"` do vitest.config.ts, que vale sempre, inclusive com
    // TZ no ambiente. Na máquina do dono (São Paulo) o fuso local coincide com
    // o do operador e esconderia o defeito.
    expect(process.env.TZ).toBe("UTC");
    expect(new Date("2026-08-19T00:30:00Z").getDate()).toBe(19);
  });

  it("os helpers viram o dia às 21h de São Paulo, não à meia-noite UTC", () => {
    const meiaNoiteUtc = new Date("2026-08-19T00:30:00Z");
    expect(formatSpDayMonth(meiaNoiteUtc)).toBe("18/08");
    expect(spDayKey(meiaNoiteUtc)).toBe("2026-08-18");
    expect(formatSpDateTime(meiaNoiteUtc)).toBe("18/08 21:30");

    const tresDaManha = new Date("2026-08-19T03:00:00Z");
    expect(formatSpDayMonth(tresDaManha)).toBe("19/08");
    expect(formatSpDateTime(tresDaManha)).toBe("19/08 00:00");
  });

  it("o formato com hora é o de dia/mês mais a hora — uma implementação só", () => {
    const instante = new Date("2026-06-15T19:00:00Z");
    expect(formatSpDateTime(instante).startsWith(formatSpDayMonth(instante))).toBe(true);
  });
});
