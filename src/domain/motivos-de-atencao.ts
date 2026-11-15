import type { MonitoramentoSummary } from "@/src/domain/monitoramento-health";

/**
 * Por que a tela pede atenção — a LEITURA do resumo, separada da derivação.
 *
 * O pill de "Atenção necessária" precisa dizer a causa e o número; só o
 * veredito, sem meio de conferir, contradiz o cartão ao lado.
 *
 * Mora em arquivo próprio porque quem lê é COMPONENTE CLIENT e quem deriva é
 * servidor: importar o módulo inteiro leva `deriveMonitoramentoSummary` e
 * `channelMonitoramentoState` para o bundle de `/operacoes` e estoura o
 * orçamento da rota. A cura é a fronteira, não um teto maior. O `import type`
 * acima some na compilação.
 *
 * Devolve a CHAVE e a contagem, nunca a frase: o texto em PT-BR (com
 * concordância de número) é da tela. Chave nova aqui sem rótulo lá é o que o
 * portão reprova. Motor e jobs não têm contagem; SLO e ações sempre têm;
 * canais sem leitura não têm.
 */
export type MotivoDeAtencao =
  | { chave: "motor" | "jobs"; n: null }
  | { chave: "slo" | "acoes"; n: number }
  | { chave: "canais"; n: number | null };

export function motivosDeAtencao(summary: MonitoramentoSummary): MotivoDeAtencao[] {
  if (!summary.available) return [];
  const motivos: MotivoDeAtencao[] = [];
  if (summary.engineState !== "healthy") motivos.push({ chave: "motor", n: null });
  if (summary.jobsState !== "healthy") motivos.push({ chave: "jobs", n: null });
  const { sloBreachTotal, degradedChannelTotal, actionableTotal } = summary;
  if (sloBreachTotal != null && sloBreachTotal > 0) motivos.push({ chave: "slo", n: sloBreachTotal });
  if (degradedChannelTotal != null && degradedChannelTotal > 0) {
    motivos.push({ chave: "canais", n: degradedChannelTotal });
  } else if (summary.channelsState !== "healthy") {
    motivos.push({ chave: "canais", n: null });
  }
  if (actionableTotal != null && actionableTotal > 0) motivos.push({ chave: "acoes", n: actionableTotal });
  return motivos;
}
