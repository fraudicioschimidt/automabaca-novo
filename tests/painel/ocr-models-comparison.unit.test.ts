import { expect, it } from "vitest";
import { buildComparisons, wilsonInterval } from "@/src/services/painel/ocr-models-comparison";

it("abre o intervalo quando a amostra é pequena e o mantém estreito com volume", () => {
  const few = wilsonInterval(3, 4);
  const many = wilsonInterval(750, 1000);
  expect(few).not.toBeNull();
  expect(many).not.toBeNull();
  expect((few!.high - few!.low)).toBeGreaterThan(many!.high - many!.low);
  expect(many!.low).toBeLessThan(0.75);
  expect(many!.high).toBeGreaterThan(0.75);
});

it("trata os extremos e a ausência de amostra", () => {
  expect(wilsonInterval(0, 0)).toBeNull();
  const none = wilsonInterval(0, 10);
  const all = wilsonInterval(10, 10);
  expect(none!.low).toBe(0);
  expect(none!.high).toBeLessThan(0.35);
  expect(all!.high).toBe(1);
  expect(all!.low).toBeGreaterThan(0.65);
  // Valores impossíveis são limitados em vez de produzir intervalo negativo.
  expect(wilsonInterval(11, 10)!.high).toBeLessThanOrEqual(1);
  expect(wilsonInterval(5, 10)!.low).toBeGreaterThanOrEqual(0);
});

it("marca como não sorteada a tarefa em que só um modelo abre o item", () => {
  const periods = buildComparisons(
    [
      { days: 1, task: "channel-player-image", provider: "gemini", model: "gemini-3.6-flash",
        assigned: 4, randomizedAssigned: 0, accepted: 0, produced: 3, rescueAttempts: 0, rescued: 0, uniqueFailures: 1 },
      { days: 1, task: "channel-image", provider: "gemini", model: "gemini-3.1-flash-lite",
        assigned: 10, randomizedAssigned: 10, accepted: 8, produced: 9, rescueAttempts: 0, rescued: 0, uniqueFailures: 1 },
      { days: 1, task: "channel-image", provider: "groq", model: "qwen/qwen3.8-27b",
        assigned: 9, randomizedAssigned: 9, accepted: 5, produced: 9, rescueAttempts: 0, rescued: 0, uniqueFailures: 3 },
    ],
    [
      { days: 1, task: "channel-player-image", resolved: false, modelsTried: 4, items: 4 },
      { days: 1, task: "channel-image", resolved: true, modelsTried: 1, items: 12 },
      { days: 1, task: "channel-image", resolved: false, modelsTried: 7, items: 3 },
    ],
    [],
  );
  const fixed = periods.find((period) => period.days === 1)?.tasks.find((task) => task.task === "channel-player-image");
  const rotated = periods.find((period) => period.days === 1)?.tasks.find((task) => task.task === "channel-image");
  expect(fixed?.randomized).toBe(false);
  expect(rotated?.randomized).toBe(true);
  expect(rotated).toMatchObject({ items: 15, resolved: 12, withoutReading: 3 });
  // Ordena por itens atribuídos: o modelo com mais amostra aparece primeiro.
  expect(rotated?.models[0]?.model).toBe("gemini-3.1-flash-lite");
});


const aggregate = (model: string, randomizedAssigned: number) => ({
  days: 7, task: "channel-image", provider: "gemini", model,
  assigned: 20, accepted: 15, produced: 20, rescueAttempts: 0, rescued: 0, uniqueFailures: 0,
  randomizedAssigned,
});

it("troca do primeiro modelo sem prova de sorteio não torna a amostra aleatória", () => {
  const [period] = buildComparisons([aggregate("a", 0), aggregate("b", 0)], [], []).filter((p) => p.days === 7);
  expect(period?.tasks[0]?.randomized).toBe(false);
});

it("sorteio comprovado não depende de observar dois modelos na primeira posição", () => {
  const [period] = buildComparisons([aggregate("a", 20)], [], []).filter((p) => p.days === 7);
  expect(period?.tasks[0]?.randomized).toBe(true);
});

it("período misto não recebe o selo de sorteio para a amostra inteira", () => {
  const [period] = buildComparisons([aggregate("a", 20), aggregate("b", 19)], [], []).filter((p) => p.days === 7);
  expect(period?.tasks[0]?.randomized).toBe(false);
});
