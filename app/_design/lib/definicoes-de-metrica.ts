/**
 * Definições das métricas: a fonte única do que cada número da tela significa.
 *
 * A mesma métrica aparece no Dashboard, na ficha da aposta e no Analyzer; escrita
 * no lugar de uso, cada tela diria uma coisa. Atenção ao CLV: é contra a fair
 * devigada, não contra a odd bruta que fechou.
 *
 * A fórmula sai do domínio, não da cabeça de quem escreve UI:
 * `percentualContraFair(bookOdd, fairOdd) = (bookOdd ÷ fairOdd − 1) × 100`
 * (`src/domain/odds.ts`) é a do CLV.
 */

export type DefinicaoDeMetrica = {
  /** Nome como aparece na tela. */
  titulo: string;
  /** Uma ou duas frases, em PT-BR, sem jargão que a própria frase não explique. */
  texto: string;
  /** Cálculo exato, quando existe um. */
  formula?: string;
};

export const DEFINICOES = {
  lucro: {
    titulo: "Lucro total",
    texto:
      "Soma do resultado de todas as apostas liquidadas, na unidade da tela: unidades no tipster, reais na carteira. Pendentes não entram — só o que já tem resultado.",
    formula: "Σ lucro das apostas resolvidas",
  },
  roi: {
    titulo: "ROI",
    texto:
      "Quanto o lucro representa do total arriscado. É a medida de eficiência: dois lucros iguais com stakes diferentes têm ROI diferente.",
    formula: "lucro ÷ stake × 100",
  },
  movimento: {
    titulo: "Movimento da linha",
    texto:
      "Quanto a odd justa da Pinnacle andou da abertura até o fechamento. Negativo: a odd caiu, o mercado passou a acreditar mais na seleção. Não depende da sua odd: mostra para onde o mercado foi.",
    formula: "(fair no fechamento ÷ fair na abertura − 1) × 100",
  },
  clv: {
    titulo: "CLV",
    texto:
      "Vantagem contra a linha que FECHOU — a melhor estimativa de probabilidade que o mercado produziu. É o indicador mais honesto de que o canal é afiado, porque não depende de a aposta ter ganhado.",
    formula: "(sua odd ÷ fair odd no fechamento − 1) × 100",
  },
  priceComparison: {
    titulo: "Comparação de odds brutas",
    texto:
      "Compara a sua odd capturada com a abertura e o fechamento brutos da Pinnacle. Diferenças também podem refletir margem e preços distintos entre casas. O CLV usa a fair do fechamento; o movimento da linha compara abertura e fechamento justos.",
    formula: "Δ = (sua odd ÷ odd bruta de referência − 1) × 100",
  },
  liquidez: {
    titulo: "Liquidez por limite cotado",
    texto:
      "Limite máximo informado pelo fornecedor para a linha cotada, usado como referência de capacidade. Não mede volume negociado nem profundidade de ordens, e não garante o limite da sua conta. As faixas e médias usam apenas valores com moeda USD confirmada; a variação compara abertura e fechamento da mesma aposta.",
  },
  fairOdd: {
    titulo: "Fair odd",
    texto:
      "A odd estimada depois de remover a margem da casa (o juice). A comparação usa a fair, pois a margem também altera a odd bruta. Com devolução ou meia decisão, a fair representa o preço de equilíbrio; seu inverso não é a probabilidade simples de vitória.",
  },
  devig: {
    titulo: "Devig",
    texto:
      "Retirada da margem estimada a partir das cotações de todos os resultados. O método produz preços justos de referência, sem garantir probabilidades reais.",
  },
  steam: {
    titulo: "Steam (a favor)",
    texto:
      "A linha justa caiu da abertura ao fechamento: o mercado passou a acreditar mais na seleção.",
  },
  drift: {
    titulo: "Drift (contra)",
    texto:
      "A linha justa subiu da abertura ao fechamento: o mercado foi contra a seleção. Zona de atenção — pode ser informação que você não tinha.",
  },
  stake: {
    titulo: "Stake",
    texto:
      "Valor arriscado, em unidades. Uma unidade vale o que você definiu no tipster, então a mesma stake em tipsters diferentes é dinheiro diferente.",
  },
  amostra: {
    titulo: "Amostra (n)",
    texto:
      "Quantas apostas entram nesta conta. Percentual com amostra pequena oscila muito — o número ao lado existe para você saber quanto confiar.",
  },
  tipsEmAberto: {
    titulo: "Apostas em aberto",
    texto: "Apostas registradas que ainda não têm resultado. Não entram em lucro nem ROI. Podem ter CLV após o fechamento confiável, mesmo antes da liquidação.",
  },
} as const satisfies Record<string, DefinicaoDeMetrica>;
