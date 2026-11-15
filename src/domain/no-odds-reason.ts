/**
 * SSOT do vocabulário de `noOddsReason` (contrato de ausência de cobertura do
 * Blueprint: ausência de odds é EXPLICADA, não muda).
 *
 * Uma lista só para o que o código grava e o que a tela diz em PT-BR; duas
 * listas divergem e a UI mostra o slug cru. O portão é o TIPO:
 * `SharpUpsertData.noOddsReason`, `ClosingWriteData.noOddsReason` e o motivo
 * da abertura (`bet_opening.noOpeningReason`) são `NoOddsReason`, então motivo
 * novo não compila sem rótulo aqui (teste: `tests/identidade/no-odds-reason.test.ts`).
 */

/**
 * De quem é a ausência, para as métricas de cobertura:
 *
 *  - `"nao_se_aplica"`: a métrica não existe para esta aposta e nunca vai
 *    existir — entrada ao vivo, política da banca, múltipla. Fica FORA do
 *    denominador. Contá-la é a métrica se medir como falha por não responder
 *    uma pergunta que ninguém fez.
 *  - `"fornecedor"`: a fonte sharp não tem o preço — mercado sem cobertura,
 *    linha que ela não oferece, jogo que ela não lista. Fica DENTRO, é o número
 *    que decide comprar cobertura e é o único que a política de segmento conta
 *    contra o fornecedor.
 *  - `"sistema"`: o preço podia existir e faltou por coisa nossa — captura que
 *    não aconteceu a tempo, seleção sem linha, esporte ainda pendente. Fica
 *    DENTRO das métricas da banca, mas não conta contra o fornecedor: o
 *    conserto é nosso.
 */
export type NoOddsReasonBase = "nao_se_aplica" | "fornecedor" | "sistema";

type NoOddsReasonSpec = {
  /** Prosa PT-BR exibida na coluna "Sem odds" e no detalhe da aposta. */
  label: string;
  /**
   * `true` = não muda esperando a Pinnacle listar/mover a linha, então re-caçar
   * odds só gasta provider. Alimenta o revive e o early-exit do enrich.
   */
  permanent: boolean;
  /**
   * Não é sinônimo de `permanent`, e confundir os dois é o erro fácil:
   * `unsupported_market` é permanente (re-caçar odd só gasta provider) E é do
   * fornecedor (comprar cobertura resolve). `permanent` responde "vale
   * re-tentar?"; este campo responde "de quem é a ausência?".
   */
  base: NoOddsReasonBase;
  /**
   * De que LADO a odd falta. O motivo mora em três tabelas — identidade
   * (`bet_sharp`), abertura (`bet_opening`) e fechamento (`bet_closing`) —, e
   * nem sempre fala da tabela onde mora: `clv_only` vive na identidade e fala
   * da odd de entrada. `"entrada"` e `"abertura"` querem dizer "a ausência não
   * alcança o fechamento"; `"ambos"`, que ela alcança todo preço da aposta.
   *
   * Quem lê precisa disso para saber se o número que está na linha É o
   * fechamento; agrupar pela tabela onde o motivo mora responde a pergunta errada.
   */
  ausencia: "entrada" | "abertura" | "fechamento" | "ambos";
};

export const NO_ODDS_REASONS = {
  // --- Linha existe no provider, mas não serve para esta aposta ---
  line_mismatch: { label: "linha diferente da casa", permanent: false, base: "fornecedor", ausencia: "ambos" },
  no_prices: { label: "sem preços na linha", permanent: false, base: "fornecedor", ausencia: "ambos" },
  market_not_listed: { label: "mercado ainda sem preços no fornecedor", permanent: false, base: "fornecedor", ausencia: "ambos" },
  sem_linha_atual: { label: "Pinnacle sem linha atual", permanent: false, base: "fornecedor", ausencia: "ambos" },
  // A seleção gravada não diz a linha ou o lado: dado nosso, da captura.
  missing_line: { label: "linha ausente na seleção", permanent: true, base: "sistema", ausencia: "ambos" },
  ambiguous_selection: { label: "seleção ambígua", permanent: true, base: "sistema", ausencia: "ambos" },
  // Vale para os dois lados da mesma ausência: o mercado que nenhum provider
  // precifica e a MODALIDADE que nenhum provider de identidade cobre.
  // Permanente E do fornecedor: re-caçar não adianta, COMPRAR cobertura
  // adianta, e sumir do denominador seria esconder a conta.
  unsupported_market: { label: "modalidade ou mercado sem cobertura sharp", permanent: true, base: "fornecedor", ausencia: "ambos" },
  // A linha não existe na referência sharp adotada pelo produto. Diferente de
  // uma lacuna comprável de provider: o CLV não é pergunta aplicável a
  // este mercado, mas a identidade do evento continua sendo útil.
  sem_referencia_sharp: {
    label: "mercado sem referência sharp — somente identidade",
    permanent: true,
    base: "nao_se_aplica", ausencia: "ambos",
  },

  // --- Política da banca: a ausência é decisão, não falha ---
  sharp_off: { label: "segmento sharp desligado", permanent: true, base: "nao_se_aplica", ausencia: "ambos" },
  clv_only: { label: "tipster em modo CLV only — o preço vem do fechamento", permanent: true, base: "nao_se_aplica", ausencia: "entrada" },
  identity_only: { label: "tipster só identidade (sem odds/CLV)", permanent: true, base: "nao_se_aplica", ausencia: "ambos" },
  multipla: {
    label: "múltipla — o CLV do ticket não se aplica",
    permanent: true,
    base: "nao_se_aplica", ausencia: "ambos",
  },

  // --- Estado do pipeline ---
  sport_pending: { label: "modalidade ainda não confirmada", permanent: false, base: "sistema", ausencia: "ambos" },
  // O preço de entrada na Pinnacle17 não foi perguntado ou não teve resposta:
  // não é a linha que falta no fornecedor. O fechamento consulta de novo.
  consulta_pinnacle_falhou: { label: "consulta à Pinnacle17 falhou", permanent: false, base: "sistema", ausencia: "entrada" },
  cota_pinnacle_esgotada: { label: "cota da Pinnacle17 esgotada", permanent: false, base: "sistema", ausencia: "entrada" },
  /**
   * A cascata de identidade rodou até o fim e NENHUM provider casou o evento.
   *
   * Diferente de `unsupported_market`, que é a modalidade/mercado sem cobertura:
   * aqui a modalidade É coberta e o jogo específico é que não casou (liga
   * menor, doubleheader, nome de time exótico). Com a cascata inteira e o
   * juiz, o comum é o fornecedor não listar o jogo; o alias errado aparece
   * como caso de treino em Operações › Vincular.
   *
   * Permanente: `classifyEnrichSkip` já trata UNMATCHED sem `kickoffInferido`
   * como `terminal_identity`, então re-caçar odd só gasta provider. Sem este
   * motivo, a aposta cairia no balde "sem motivo gravado" com a causa conhecida.
   */
  identidade_nao_casada: {
    label: "nenhum provider casou a identidade do evento",
    permanent: true,
    base: "fornecedor", ausencia: "ambos",
  },
  /**
   * `evento` não tem o formato "A vs B", então não há o que casar. É defeito de
   * dado NOSSO (captura/parsing): fica DENTRO da base, senão a métrica
   * premiaria o próprio bug.
   */
  evento_sem_formato: {
    label: "evento sem formato “A vs B” — identidade não pôde ser tentada",
    permanent: true,
    base: "sistema", ausencia: "ambos",
  },

  // --- Fechamento (BetClosing) ---
  // Nenhuma resposta do fornecedor perto do apito: a captura é que faltou.
  kickoff_sem_captura: { label: "kickoff sem captura de closing", permanent: false, base: "sistema", ausencia: "fechamento" },
  // Permanente: uma entrada ao vivo nunca vira pré-jogo, então re-caçar odd só
  // gasta provider. Ver `domain/entrada-ao-vivo.ts` para o porquê de não haver CLV.
  aposta_ao_vivo: { label: "entrada ao vivo — CLV não se aplica", permanent: true, base: "nao_se_aplica", ausencia: "fechamento" },
  // Há preço da Pinnacle, mas a última cotação foi tirada longe do apito e a
  // linha ainda se move: não é o fechamento, e a captura perto do apito é que
  // faltou.
  closing_quote_too_early: {
    label: "última cotação a mais de 10 min do kickoff — CLV não confiável",
    permanent: false, base: "sistema", ausencia: "fechamento",
  },

  // --- Abertura (BetOpening, colhida na BridgeOdds depois do jogo) ---
  // A coleta tenta de novo até o teto de tentativas dela, qualquer que seja o
  // motivo; por isso nenhum é permanente.
  partida_nao_localizada: {
    label: "jogo não localizado na BridgeOdds",
    permanent: false, base: "fornecedor", ausencia: "ambos",
  },
  sem_abertura_na_linha: {
    label: "linha da BridgeOdds sem abertura",
    permanent: false, base: "fornecedor", ausencia: "abertura",
  },
  falha_na_consulta: {
    label: "consulta à BridgeOdds falhou",
    permanent: false, base: "sistema", ausencia: "abertura",
  },
} as const satisfies Record<string, NoOddsReasonSpec>;

/**
 * A ausência declarada alcança o FECHAMENTO?
 *
 * Desconhecido conta como SIM — e a direção é o oposto da denylist de
 * `isPermanentNoOddsReason`, de propósito. Lá a pergunta é "vale re-tentar?", e
 * errar para o lado de re-tentar custa uma chamada. Aqui a pergunta é "posso
 * exibir este número como o fechamento?", e errar para o lado de exibir publica
 * uma MENTIRA para o operador. Omitir mostra "—"; publicar mostra um preço que
 * a aposta nunca teve.
 */
export function ausenciaAlcancaFechamento(reason: string | null | undefined): boolean {
  if (reason == null) return false;
  const spec = (NO_ODDS_REASONS as Record<string, NoOddsReasonSpec | undefined>)[reason];
  if (!spec) return true;
  return spec.ausencia === "fechamento" || spec.ausencia === "ambos";
}

/**
 * A linha guarda um fechamento CONFIRMADO — o preço que a tela, o CSV e o
 * analyzer podem chamar de "fechamento".
 *
 * `closingFetchedAt` sozinho NÃO responde isso, e o contrato de
 * `writeClosingOnce` sempre disse por quê: o campo marca "já tentou congelar
 * CLV (**mesmo sem odd**)". Quem congela SEM odd — a guarda de entrada ao vivo
 * é o caso — deixa ali a linha PROVISÓRIA escrita pré-kickoff por
 * `upsertProvisional`, e ler só o campo a promoveria a "fechamento": a ficha
 * mostraria um movimento contra um preço que nunca fechou, e a base
 * "entrada → fechamento" do analyzer (`computeSteamV1`) teria o sinal distorcido
 * por essas linhas. O CLV em si não sofre (exige `clvReliable`); as métricas
 * vizinhas sim.
 *
 * Responde a POLÍTICA, não a presença do campo: quem lê `closingOdd` confere
 * `closingOdd`, quem lê `closingRawOdd` confere `closingRawOdd`.
 */
export function fechamentoConfirmado(row: {
  closingFetchedAt?: Date | null;
  closingNoOddsReason?: string | null;
}): boolean {
  if (row.closingFetchedAt == null) return false;
  return !ausenciaAlcancaFechamento(row.closingNoOddsReason);
}

/**
 * O motivo que explica o CLV que falta (coluna "Sem odds" e CSV). O do
 * fechamento (`bet_closing`) vem primeiro; o da identidade (`bet_sharp`) só
 * quando a ausência alcança o fechamento — `clv_only` fala da entrada. Com o
 * CLV confiável congelado, não falta nada.
 */
export function missingClvReason(row: {
  clvReliable: boolean | null;
  closingFetchedAt?: Date | null;
  noOddsReason: string | null;
  closingNoOddsReason: string | null;
}): string | null {
  if (row.closingFetchedAt != null && row.clvReliable === true) return null;
  if (row.closingNoOddsReason) return row.closingNoOddsReason;
  return row.noOddsReason && ausenciaAlcancaFechamento(row.noOddsReason) ? row.noOddsReason : null;
}

export type NoOddsReason = keyof typeof NO_ODDS_REASONS;

/**
 * Motivos PERMANENTES — derivados da tabela acima, nunca redigitados.
 *
 * A semântica de DENYLIST continua: quem consulta pergunta "está nesta lista?",
 * e string desconhecida (motivo de outra versão do código) cai como
 * TRANSITÓRIA e re-tenta. Perder uma linha que apareceria é pior que uma
 * chamada extra.
 */
export const PERMANENT_NO_ODDS_REASONS: readonly NoOddsReason[] = Object.entries(NO_ODDS_REASONS)
  .flatMap(([reason, spec]) => (spec.permanent ? [reason as NoOddsReason] : []));

export function isPermanentNoOddsReason(
  reason: string | null | undefined,
): reason is NoOddsReason {
  return reason != null && (PERMANENT_NO_ODDS_REASONS as readonly string[]).includes(reason);
}

/**
 * Motivos que tiram a aposta do DENOMINADOR de uma métrica de cobertura —
 * derivados da tabela acima, nunca redigitados.
 *
 * A semântica é o espelho da denylist de `PERMANENT_NO_ODDS_REASONS`: motivo
 * desconhecido (motivo de outra versão do código) NÃO sai da base. O viés é
 * deliberado — cobertura otimista demais é a doença que este conceito veio
 * curar, então na dúvida a aposta continua contando contra nós.
 */
export const MOTIVOS_FORA_DA_BASE: readonly NoOddsReason[] = Object.entries(NO_ODDS_REASONS)
  .flatMap(([reason, spec]) => (spec.base === "nao_se_aplica" ? [reason as NoOddsReason] : []));

/** `true` = a métrica não alcança esta aposta; ela sai do denominador. */
export function foraDaBaseDeCobertura(reason: string | null | undefined): boolean {
  return reason != null && (MOTIVOS_FORA_DA_BASE as readonly string[]).includes(reason);
}

/**
 * Motivos de ausência que são do FORNECEDOR — derivados da tabela acima. Só
 * eles contam contra o fornecedor na política de segmento: falha nossa e
 * motivo desconhecido não são observação dele.
 */
export const SUPPLIER_NO_ODDS_REASONS: readonly NoOddsReason[] = Object.entries(NO_ODDS_REASONS)
  .flatMap(([reason, spec]) => (spec.base === "fornecedor" ? [reason as NoOddsReason] : []));

/**
 * De quem é a ausência. Motivo desconhecido é `sistema`: o vocabulário que não
 * o conhece é conserto nosso, e ele continua contando contra nós nas métricas
 * da banca.
 */
export function noOddsReasonBase(reason: string): NoOddsReasonBase {
  return (NO_ODDS_REASONS as Record<string, NoOddsReasonSpec | undefined>)[reason]?.base ?? "sistema";
}

/**
 * Prosa PT-BR do motivo. Slug desconhecido volta como veio: a tela mostrar o
 * código cru é ruim, mas esconder a linha é pior.
 */
export function noOddsReasonLabel(reason: string): string {
  return (NO_ODDS_REASONS as Record<string, NoOddsReasonSpec>)[reason]?.label ?? reason;
}
