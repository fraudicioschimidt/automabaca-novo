import { describe, expect, it } from "vitest";
import {
  CADENCIA_DO_CARIMBO_MS,
  FONTES_DE_FRESCOR,
  TOLERANCIA_DE_CICLOS,
  fonteDeFrescor,
  frescorDaFonte,
  toleranciaDeCadencia,
  toleranciaMin,
} from "@/src/domain/frescor";
import { spRelative } from "@/src/domain/dates";
import { WORKER_HEARTBEAT_STALE_MIN } from "@/src/domain/health";
import { cadenciaDaFila } from "../helpers/cadencia";
import { textoDaTiraDeFrescor, textoDeFrescor } from "@/app/_design/lib/frescor-na-tela";

/**
 * Número exibido cuja fonte pode envelhecer não envelhece em SILÊNCIO — e o
 * corolário: não alarmar sobre fonte que não prometeu nada.
 *
 * Sem carimbo de idade, nada na tela distingue "não teve jogo" de "o bot
 * morreu", e o operador lê contagens e coberturas sem saber de quando são.
 *
 * O remédio ingênuo — carimbar tudo e ficar vermelho no atraso — cria um defeito
 * pior: "captura há 3 h" numa terça sem jogo viraria alerta, e um sinal de saúde
 * que grita à toa é um sinal que o operador aprende a ignorar. Por isso metade
 * deste portão defende o carimbo e a outra metade defende o SILÊNCIO dele.
 *
 * Quatro metades, e nenhuma sozinha basta:
 *  1. relógio do mundo nunca alarma;
 *  2. o limiar é DERIVADO da cadência real do cron, nunca digitado;
 *  3. fonte declarada tem rótulo próprio na tira;
 *  4. o texto e o veredito saem da MESMA leitura do relógio.
 */

const AGORA = new Date("2026-08-12T12:00:00.000Z");

function minutosAtras(n: number): Date {
  return new Date(AGORA.getTime() - n * 60_000);
}

describe("1. o relógio do MUNDO nunca alarma", () => {
  it("fonte sem cadência não fica atrasada nem com um ano de idade", () => {
    const semCadencia = FONTES_DE_FRESCOR.filter((f) => f.cadenciaMin == null);
    expect(semCadencia.length).toBeGreaterThan(0);
    for (const fonte of semCadencia) {
      const antigo = frescorDaFonte(fonte, minutosAtras(365 * 24 * 60), AGORA);
      expect(antigo.atrasada, `${fonte.chave} alarmou com um ano de idade`).toBe(false);
      expect(toleranciaMin(fonte)).toBeNull();
      // Nem quando o instante nunca existiu: "nenhuma aposta ainda" não é
      // defeito de ninguém, é uma terça sem jogo.
      expect(frescorDaFonte(fonte, null, AGORA).atrasada).toBe(false);
    }
  });

  it("fonte COM cadência alarma, inclusive quando nunca rodou", () => {
    const comCadencia = FONTES_DE_FRESCOR.filter((f) => f.cadenciaMin != null);
    expect(comCadencia.length).toBeGreaterThan(0);
    for (const fonte of comCadencia) {
      const tolerancia = toleranciaDeCadencia(fonte.chave);
      expect(frescorDaFonte(fonte, minutosAtras(tolerancia + 1), AGORA).atrasada).toBe(true);
      // Nunca ter rodado é atraso para quem prometeu cadência — é o que
      // `workerVivo` já decide com heartbeat nulo.
      expect(frescorDaFonte(fonte, null, AGORA).atrasada).toBe(true);
    }
  });
});

describe("2. o limiar é DERIVADO da cadência real, nunca digitado", () => {
  it("cada fonte com cadência bate com o cron do SCHEDULE_MANIFEST", () => {
    for (const fonte of FONTES_DE_FRESCOR) {
      if (fonte.cadenciaMin == null) {
        expect(fonte.fila, `${fonte.chave} sem cadência não pode nomear fila`).toBeNull();
        continue;
      }
      expect(fonte.fila, `${fonte.chave} promete cadência e não diz de que fila`).toBeTruthy();
      expect(cadenciaDaFila(fonte.fila as string)).toBe(fonte.cadenciaMin);
    }
  });

  it("WORKER_HEARTBEAT_STALE_MIN é consequência da cadência, não um segundo 15", () => {
    expect(WORKER_HEARTBEAT_STALE_MIN).toBe(toleranciaDeCadencia("motor"));
    expect(WORKER_HEARTBEAT_STALE_MIN).toBe(
      cadenciaDaFila("health.heartbeat") * TOLERANCIA_DE_CICLOS,
    );
  });

  it("toleranciaDeCadencia recusa fonte sem relógio nosso em vez de inventar um", () => {
    expect(() => toleranciaDeCadencia("captura")).toThrow(/não declara cadência/);
  });
});

describe("3. fonte declarada tem rótulo próprio na tira", () => {
  it("os rótulos são distintos: duas fontes com o mesmo nome viram uma na tira", () => {
    const rotulos = FONTES_DE_FRESCOR.map((f) => f.rotulo);
    expect(new Set(rotulos).size).toBe(rotulos.length);
  });
});

describe("4. o texto e o veredito saem da MESMA leitura", () => {
  it("na fronteira exata da tolerância, os dois concordam", () => {
    const fonte = fonteDeFrescor("motor");
    const tolerancia = toleranciaDeCadencia("motor");

    const noLimite = frescorDaFonte(fonte, minutosAtras(tolerancia), AGORA);
    expect(noLimite.idadeMin).toBe(tolerancia);
    expect(noLimite.atrasada).toBe(false);

    const umAlem = frescorDaFonte(fonte, minutosAtras(tolerancia + 1), AGORA);
    expect(umAlem.idadeMin).toBe(tolerancia + 1);
    expect(umAlem.atrasada).toBe(true);
  });

  it("instante no futuro vira 'agora' nos DOIS — idade e texto", () => {
    // Desvio de relógio entre o Postgres e o processo é real. Sem o clamp antes
    // da formatação, `idadeMin` sairia 0 e `texto` sairia "em 119 min": a mesma
    // grandeza dizendo duas coisas na mesma linha.
    const futuro = new Date(AGORA.getTime() + 119 * 60_000);
    const f = frescorDaFonte(fonteDeFrescor("motor"), futuro, AGORA);
    expect(f.idadeMin).toBe(0);
    expect(f.texto).toBe("agora");
    expect(f.atrasada).toBe(false);
  });

  it("formata a idade: sem heartbeat, agora, minutos e horas", () => {
    const motor = fonteDeFrescor("motor");
    expect(frescorDaFonte(motor, null, AGORA).texto).toBe("sem heartbeat");
    expect(frescorDaFonte(motor, minutosAtras(0), AGORA).texto).toBe("agora");
    expect(frescorDaFonte(motor, minutosAtras(5), AGORA).texto).toBe("há 5 min");
    expect(frescorDaFonte(motor, minutosAtras(119), AGORA).texto).toBe("há 1 h");
  });

  it("a tira compõe rótulo + idade, e marca o atraso no TEXTO", () => {
    const captura = frescorDaFonte(fonteDeFrescor("captura"), minutosAtras(74), AGORA);
    const motor = frescorDaFonte(fonteDeFrescor("motor"), minutosAtras(90), AGORA);

    expect(textoDeFrescor(captura)).toBe("captura há 1 h");
    // Sem dado, a frase da fonte vai INTEIRA: "captura nenhuma aposta" não é
    // português, e é o que sairia se a tira concatenasse sempre.
    expect(textoDeFrescor(frescorDaFonte(fonteDeFrescor("captura"), null, AGORA)))
      .toBe("nenhuma aposta ainda");
    // O atraso vai no texto, não só na cor: cor não chega ao leitor de tela.
    expect(textoDaTiraDeFrescor([captura, motor])).toBe(
      "captura há 1 h · motor há 1 h · atrasado",
    );
  });
});

/**
 * O carimbo tem de ENVELHECER. Renderizado só no servidor, ele congela: aba
 * aberta às 09:00 seguiria dizendo "captura há 1 h" às 13:00. Um carimbo parado é
 * pior que nenhum, porque afirma uma idade que já não é verdade.
 */
describe("o carimbo envelhece na tela", () => {
  it("o Frescor carrega o INSTANTE, não só o texto — sem ele não há o que recalcular", () => {
    const f = frescorDaFonte(fonteDeFrescor("captura"), minutosAtras(74), AGORA);
    expect(f.emISO).toBe(minutosAtras(74).toISOString());
    // Sem dado não há instante, e a frase é fixa por natureza.
    expect(frescorDaFonte(fonteDeFrescor("captura"), null, AGORA).emISO).toBe(null);
  });

  it("recalcular do instante dá o mesmo que o servidor daria naquela hora", () => {
    const captura = fonteDeFrescor("captura");
    const doServidor = frescorDaFonte(captura, minutosAtras(50), AGORA);
    // Duas horas depois, com o MESMO instante: é o que o navegador faz.
    const depois = new Date(AGORA.getTime() + 120 * 60_000);
    const noCliente = frescorDaFonte(captura, new Date(doServidor.emISO!), depois);

    expect(doServidor.texto).toBe("há 50 min");
    expect(noCliente.texto).toBe("há 2 h");
    // E continua sendo a MESMA derivação: idade e texto de uma leitura só.
    expect(noCliente.idadeMin).toBe(170);
  });

  it("o clamp do futuro sobrevive à ida e volta pelo instante", () => {
    // O servidor grampeia um instante futuro em "agora". Se `emISO` levasse o
    // instante CRU, o cliente voltaria a exibir "em N min" — o clamp precisa
    // estar no que atravessa, não só no que é renderizado.
    const futuro = new Date(AGORA.getTime() + 90 * 60_000);
    const f = frescorDaFonte(fonteDeFrescor("motor"), futuro, AGORA);
    expect(new Date(f.emISO!).getTime()).toBe(AGORA.getTime());
    expect(frescorDaFonte(fonteDeFrescor("motor"), new Date(f.emISO!), AGORA).texto).toBe("agora");
  });

  it("o tique é mais rápido que a menor unidade que o texto distingue", () => {
    // Mede a resolução em vez de confiar no comentário: o menor delta que muda
    // a frase de `spRelative`.
    const base = new Date("2026-08-12T12:00:00Z");
    let resolucaoMs = 0;
    for (let ms = 1_000; ms <= 5 * 60_000; ms += 1_000) {
      if (spRelative(new Date(base.getTime() - ms), base) !== spRelative(base, base)) {
        resolucaoMs = ms;
        break;
      }
    }
    expect(resolucaoMs).toBeGreaterThan(0);
    expect(
      CADENCIA_DO_CARIMBO_MS,
      `tique de ${CADENCIA_DO_CARIMBO_MS}ms com resolução de ${resolucaoMs}ms: `
      + "o texto pularia uma unidade (de \"agora\" direto para \"há 2 min\")",
    ).toBeLessThan(resolucaoMs);
    // E não tão quente a ponto de re-renderizar à toa.
    expect(CADENCIA_DO_CARIMBO_MS).toBeGreaterThanOrEqual(5_000);
  });
});
