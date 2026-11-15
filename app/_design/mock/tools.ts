// Dados de demonstração da tela Ferramentas (calculadora Kelly), na forma do adaptador.
import type { getToolsData } from "../adapters/tools";

export const TOOLS: Awaited<ReturnType<typeof getToolsData>> = {
  bankrolls: [],
  selectedBankrollId: null,
  selectedBankrollNome: "Ana Sharp",
  clvCanal: { nome: "Ana Sharp", media: 2.4, n: 88, verdict: "forte", faltam: 0 },
};
