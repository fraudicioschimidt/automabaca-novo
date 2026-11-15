/**
 * Formas da trilha. Arquivo separado só para `leitura.ts` poder usar
 * `MudancaDeCampo` sem importar do `index`, que importa `leitura` de volta.
 */

/** Um pedaço da frase. `forte` = o que difere entre dois eventos do mesmo tipo. */
export type Trecho = { texto: string; forte?: boolean };

/** Uma linha do diff de `bet.edit` / `bet.market_correct`. */
export type MudancaDeCampo = { campo: string; de: string; para: string };

export type Narracao = {
  frase: Trecho[];
  /** Só quando o evento É um diff. A frase permanece uniforme. */
  mudancas?: MudancaDeCampo[];
};

/**
 * As chaves são o vocabulário FECHADO da trilha. Uma tela que exibe evento
 * fora desta lista não existe: `classificarEvento` só devolve daqui.
 */
export type ChaveDeEvento =
  | "captura"
  | "captura_repetida"
  | "edicao"
  | "nao_peguei"
  | "nao_peguei_desfeito"
  | "peguei"
  | "peguei_desfeito"
  | "mercado_corrigido"
  | "identidade_auto"
  | "identidade_llm"
  | "identidade_vinculada"
  | "kickoff_corrigido"
  | "kickoff_tentativa"
  | "kickoff_outro_esporte"
  | "kickoff_remarcado"
  | "reabertura"
  | "liquidacao"
  | "reliquidacao"
  | "liquidacao_delegada"
  | "esporte_por_operador";

export type EventoSpec = {
  /** Rótulo curto, para o agrupamento e para a legenda. */
  rotulo: string;
  /**
   * Como o evento se lê. O conectivo (trechos sem `forte`) tem de ser IGUAL
   * para quaisquer dois eventos deste tipo — é o que o portão prova.
   */
  narrar: (e: EventoBruto) => Narracao;
  /**
   * A `action` de `audit_events` que origina este tipo, ou `null` quando ele
   * nasce de `settlement_events`. A retenção da purga DERIVA daqui: evento que
   * a trilha exibe não pode ser apagado antes da aposta.
   */
  acaoDeAuditoria: string | null;
};

/** O evento já lido do banco, antes de virar prosa. */
export type EventoBruto = {
  chave: ChaveDeEvento;
  em: Date;
  /** Quem fez: `system`, `fabricio`, `sport-resolver`, `telegram-channel:…`. */
  ator: string;
  /** `success` | qualquer outra coisa — a tela marca o que não foi sucesso. */
  outcome: string;
  /**
   * O `details` cru do banco, `Json?` e portanto sem forma garantida.
   *
   * Sem Zod por tipo, de propósito: `details` é escrita NOSSA, não saída de
   * LLM, e os leitores de `leitura.ts` (`texto`, `numero`, `objeto`,
   * `instante`) já são TOTAIS — qualquer forma cai em "—" em vez de estourar.
   * Um esquema por tipo que diverge do gravador seria pior que nenhum. O portão
   * prova a totalidade com `dados: {}` em todos os tipos.
   */
  dados: Record<string, unknown>;
};
