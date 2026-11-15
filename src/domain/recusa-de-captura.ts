/**
 * O que uma recusa de captura SIGNIFICA — e o rendimento que ela mede.
 *
 * 1. Contar POST, não evento. `audit_events` grava uma linha por TENTATIVA de
 *    parse, e a mesma mensagem é reprocessada a cada edit e a cada retry da
 *    fila; somar linhas conta o mesmo post várias vezes e infla a perda. O
 *    critério de captura é "algum evento do post gravou aposta", não "o último
 *    evento" (post capturado e depois editado termina em `not_bet`): o funil
 *    tem de bater com a lista que o operador confere. O MOTIVO é o do último
 *    veredito, o diagnóstico mais recente.
 *
 * 2. Uma definição só de "o motor falhou". `guard_rejected` é falha e
 *    `not_bet` é descarte correto; errar qualquer um dos dois inverte o
 *    ranking de canais no corte de `channelMonitoramentoState`. Uma
 *    implementação por conceito: a porta é `rendimentoDoMotor`, e
 *    `tests/captura/recusa-de-captura.test.ts` reprova a próxima cópia.
 *
 * Puro, sem I/O. Quem lê o banco é `services/painel/operacoes/channels` (o
 * cartão de canais).
 */

/**
 * O que a perda SIGNIFICA — é isso que decide se ela entra na conta de
 * "rendimento do motor" e o que fazer a respeito.
 */
export type ClasseDePerda =
  /** O post não era uma aposta. O motor acertou ao recusar. */
  | "descarte_correto"
  /** Faltou informação na legenda, ou não sabemos ler aquela forma. */
  | "legenda_incompleta"
  /**
   * Faltou um insumo EXTERNO para ler o post — leitura da IA, mídia original
   * sumida. As duas decidem igual (é falha, e é retentável), então são uma
   * classe só: o que a classe decide é o que ela separa.
   */
  | "recurso_externo"
  /** O operador recusou depois de capturada ("não peguei"). */
  | "decisao_do_operador"
  /** Virou aposta na auditoria e não está no histórico — nem viva, nem
   *  recusada. Não é falha do motor de LEITURA (ele leu), então fica fora de
   *  `CLASSES_QUE_SAO_FALHA`; existe para a diferença ter nome em vez de ser
   *  absorvida pelo balde do 👎. */
  | "registro_ausente";

export type Verbete = {
  readonly classe: ClasseDePerda;
  /** Curto, para a linha da perda. */
  readonly rotulo: string;
  /** O que fazer a respeito — vazio quando não há o que fazer. */
  readonly proximaEtapa: string;
  /**
   * Ajuste na banca que faz o motivo parar de se repetir no canal, quando
   * existe. É o que o aviso de recusas repetidas sugere.
   */
  readonly consertoNoCanal?: string;
};

/** Chave de quem recusou e não disse por quê. Balde declarado, não silêncio. */
export const MOTIVO_SEM_REGISTRO = "sem_motivo_gravado";

/**
 * O vocabulário, motivo a motivo, como os emissores os gravam em
 * `audit_events.details->>'reason'`.
 *
 * FAIL-CLOSED em dois níveis. Motivo novo sem verbete não vira "outros" em
 * silêncio: sai em `motivosDesconhecidos`, conta como falha (pessimista de
 * propósito) e o portão reprova. E o portão varre os EMISSORES
 * (`parse-capture-guard`, `prepare-capture`, `capture-new`, `capture-edit-*`)
 * exigindo verbete para cada `reason` que eles podem escrever — sem isso, o
 * motivo apareceria na tela como slug.
 */
export const MOTIVOS_DE_PERDA: Readonly<Record<string, Verbete>> = {
  not_bet: {
    classe: "descarte_correto",
    rotulo: "não era aposta",
    proximaEtapa: "",
  },
  /** Os dois abaixo vêm da LISTA de apostas, não da auditoria de parse: são o
   *  desfecho do último degrau do funil. Moram aqui porque rótulo de perda tem
   *  um lugar só — inline no funil, `nao_peguei` era a 2ª grafia. */
  nao_peguei: {
    classe: "decisao_do_operador",
    rotulo: "você recusou no 👎",
    proximaEtapa: "",
  },
  sem_registro_de_aposta: {
    classe: "registro_ausente",
    rotulo: "gravada sem linha no histórico",
    proximaEtapa: "a auditoria diz que virou aposta e a linha não existe — conferir se saiu fora do 👎",
  },
  mercado_total_ambiguo: {
    classe: "legenda_incompleta",
    rotulo: "Total sem dizer a unidade (gols, escanteios ou cartões)",
    proximaEtapa: "o guard recusa de propósito: liquidar pelo placar de gols um total de escanteios ou cartões daria o resultado errado",
    consertoNoCanal: "se o canal não é de futebol, defina os esportes dele em Config › Tipsters; se é, só o post dizendo a unidade do total resolve",
  },
  lado_handicap_ausente: {
    classe: "legenda_incompleta",
    rotulo: "Handicap sem dizer de quem é a linha",
    proximaEtapa: "o guard recusa de propósito: sem o lado não há como liquidar",
  },
  linha_handicap_ausente: {
    classe: "legenda_incompleta",
    rotulo: "Handicap sem o valor da linha",
    proximaEtapa: "o guard recusa de propósito: sem a linha não há como liquidar",
  },
  legenda_com_multiplas_apostas: {
    classe: "legenda_incompleta",
    rotulo: "uma legenda com várias apostas",
    proximaEtapa: "o post precisa vir separado, ou o parser aprender a dividir",
  },
  evento_ausente: {
    classe: "legenda_incompleta",
    rotulo: "post sem dizer que jogo é",
    proximaEtapa: "sem o evento não há o que casar com a linha do mercado",
  },
  selecao_ausente: {
    classe: "legenda_incompleta",
    rotulo: "post sem dizer qual é a aposta",
    proximaEtapa: "sem seleção não há o que liquidar",
  },
  selecao_combinada: {
    classe: "legenda_incompleta",
    rotulo: "duas condições numa seleção só (aposta combinada)",
    proximaEtapa: "a leitura não separou as pernas da combinada, e gravá-la num mercado simples liquidaria só uma das condições: registre à mão como múltipla",
  },
  odd_legenda_ausente: {
    classe: "legenda_incompleta",
    rotulo: "legenda sem a odd",
    proximaEtapa: "a odd decide o lucro: o guard não a inventa",
    consertoNoCanal: "se a odd certa é a do print, troque a fonte da odd do tipster para a imagem em Config › Tipsters",
  },
  odd_invalida: {
    classe: "legenda_incompleta",
    rotulo: "odd fora do teto de sanidade",
    proximaEtapa: "saída de LLM é input hostil — a odd lida não passou no teto",
  },
  odd_diverge_legenda: {
    classe: "legenda_incompleta",
    rotulo: "odd lida muito diferente da que está na legenda",
    proximaEtapa: "odd do print e \"@\" da legenda diferem mais de 25%, em qualquer fonte de odd do tipster: uma das duas foi lida errada — responda a odd certa no conserto pela DM",
  },
  odd_implausivel: {
    classe: "legenda_incompleta",
    rotulo: "odd alta demais para o mercado",
    proximaEtapa: "acima de 20 num mercado de placar simples, do jogo inteiro ou de uma parte dele, é quase sempre a odd sem o ponto (\"@185\"): confira o post",
  },
  placar_ao_vivo_ausente: {
    classe: "legenda_incompleta",
    rotulo: "handicap ao vivo sem o placar da entrada",
    proximaEtapa: "o handicap ao vivo liquida pelo placar restante: informe o placar da hora da tip no conserto pela DM",
  },
  handicap_tipo_ambiguo: {
    classe: "legenda_incompleta",
    rotulo: "handicap sem dizer se é asiático ou europeu",
    proximaEtapa: "com linha inteira, o asiático devolve na cobertura exata e o europeu perde: escolha o tipo no conserto pela DM",
  },
  ambiguous_ticket: {
    classe: "legenda_incompleta",
    rotulo: "várias seleções com a mesma odd, sem dizer se é múltipla",
    proximaEtapa: "pode ser uma múltipla com a odd total ou várias simples: confira o post e registre à mão",
  },
  stake_invalido: {
    classe: "legenda_incompleta",
    rotulo: "stake ilegível",
    proximaEtapa: "sem stake não há exposição para registrar",
    consertoNoCanal: "se o canal não escreve a stake, defina a stake padrão do tipster em Config › Tipsters",
  },
  stake_invalida: {
    classe: "legenda_incompleta",
    rotulo: "stake de um item do lote ilegível",
    proximaEtapa: "sem stake não há exposição para registrar: confira o post e registre à mão",
  },
  stake_diverge_legenda: {
    classe: "legenda_incompleta",
    rotulo: "stake da legenda diferente da de uma das apostas do post",
    proximaEtapa: "o post tem várias apostas e uma stake só na legenda, sem \"cada\": não se sabe de qual aposta ela é — registre à mão",
  },
  quantidade_de_stakes_divergente: {
    classe: "legenda_incompleta",
    rotulo: "número de stakes diferente do de seleções",
    proximaEtapa: "a legenda não diz qual stake vai em qual seleção: o lote não adivinha",
  },
  stake_em_unidades_nao_comprovada: {
    classe: "legenda_incompleta",
    rotulo: "stake do print sem prova de que é em unidades",
    proximaEtapa: "o valor do bilhete pode ser em reais: o lote só grava stake em unidades comprovada",
    consertoNoCanal: "se o canal escreve a stake em unidades no print e o tipster é só de identidade, marque \"Valor do print representa unidades\" dele em Config › Jogadores",
  },
  selecoes_indistinguiveis: {
    classe: "legenda_incompleta",
    rotulo: "lote com seleções repetidas",
    proximaEtapa: "duas seleções iguais no mesmo post: o lote não tem como separá-las — registre à mão",
  },
  lote_vazio: {
    classe: "legenda_incompleta",
    rotulo: "lote sem nenhuma seleção",
    proximaEtapa: "a leitura não deixou seleção para gravar: confira o post",
  },
  lote_alterado_precisa_revisao: {
    classe: "legenda_incompleta",
    rotulo: "lote diferente do já gravado",
    proximaEtapa: "a releitura trouxe outras seleções para um post já capturado: confira o lote gravado",
  },
  lote_incompleto_precisa_revisao: {
    classe: "legenda_incompleta",
    rotulo: "item do lote já registrado em outra aposta",
    proximaEtapa: "o lote não foi gravado pela metade: confira as apostas do post e registre à mão o que faltar",
  },
  selecao_da_legenda_ambigua: {
    classe: "legenda_incompleta",
    rotulo: "legenda com mais de uma seleção possível no print",
    proximaEtapa: "a legenda não aponta uma linha só do bilhete: o guard não escolhe por ela",
  },
  selecao_diverge_legenda: {
    classe: "legenda_incompleta",
    rotulo: "seleção da legenda não está no print",
    proximaEtapa: "a linha escrita não aparece no bilhete lido: confira o post",
  },
  incomplete_live_score: {
    classe: "legenda_incompleta",
    rotulo: "placar ao vivo pela metade ou ausente",
    proximaEtapa: "a entrada ao vivo precisa do placar dos dois times na hora da tip; handicap ao vivo sem esse placar não é liquidado pelo jogo inteiro",
  },
  invalid_live_score: {
    classe: "legenda_incompleta",
    rotulo: "placar ao vivo ilegível",
    proximaEtapa: "o placar da entrada ao vivo não passou na leitura: confira o post",
  },
  conflicting_live_score: {
    classe: "legenda_incompleta",
    rotulo: "dois placares ao vivo diferentes no post",
    proximaEtapa: "o guard não escolhe entre placares: confira o post",
  },
  incomplete_extraction: {
    classe: "legenda_incompleta",
    rotulo: "leitura sem todos os jogos, mercados e seleções",
    proximaEtapa: "confira a mensagem original e registre à mão",
  },
  inconsistent_extraction: {
    classe: "legenda_incompleta",
    rotulo: "leitura inconsistente do bilhete",
    proximaEtapa: "confira a mensagem original e registre à mão",
  },
  invalid_extraction_contract: {
    classe: "legenda_incompleta",
    rotulo: "leitura fora do formato esperado",
    proximaEtapa: "a IA disse que é aposta, mas não devolveu os campos: registre à mão",
  },
  incomplete_player_terms: {
    classe: "legenda_incompleta",
    rotulo: "aposta de jogador sem todos os termos",
    proximaEtapa: "sem jogador, estatística e linha não há como liquidar: registre à mão",
  },
  incomplete_fixture: {
    classe: "legenda_incompleta",
    rotulo: "confronto cortado ou incompleto",
    proximaEtapa: "o guard não inventa adversário: confira o post e registre à mão",
  },
  unmarked_selection: {
    classe: "legenda_incompleta",
    rotulo: "print da grade sem a opção marcada",
    proximaEtapa: "o tipster não marcou qual opção pegou: escolha a opção no conserto pela DM",
  },
  ambiguous_bet: {
    classe: "legenda_incompleta",
    rotulo: "a IA não soube dizer a aposta com segurança",
    proximaEtapa: "a leitura apontou uma dúvida que muda o resultado (lado, linha ou período), dita no aviso: confira o post e registre à mão",
  },
  combined_player_ticket: {
    classe: "legenda_incompleta",
    rotulo: "bilhete combinado de jogadores",
    proximaEtapa: "ainda não há como liquidar a combinada de jogadores: registre à mão",
  },
  ocr_split_handicap_conflict: {
    classe: "legenda_incompleta",
    rotulo: "linha de handicap dividida lida de dois jeitos",
    proximaEtapa: "os leitores discordam da linha: confira o print",
  },
  stake_implausivel: {
    classe: "legenda_incompleta",
    rotulo: "stake lida do post acima de 20u",
    proximaEtapa: "costuma ser dinheiro ou meta lidos como unidades; a stake padrão do tipster não conta — responda a stake no conserto pela DM ou, acima de 20u, registre pelo painel",
  },
  rascunho_sem_stake: {
    classe: "legenda_incompleta",
    rotulo: "rascunho que nunca foi completado",
    proximaEtapa: "o post saiu sem stake/odd e o edit que os traria não veio",
  },
  /** Algum provedor que leria não respondeu (cota, transporte, cooldown ou
   * circuito): a captura relança o post. O rótulo não pode prometer só "cota". */
  llm_exhausted: {
    classe: "recurso_externo",
    rotulo: "a IA não conseguiu ler o post",
    proximaEtapa: "sem cota ou sem resposta de algum provedor — a leitura é tentada de novo; se não sair, registre à mão",
  },
  leitura_recusada_pela_ia: {
    classe: "legenda_incompleta",
    rotulo: "a IA leu e não achou uma aposta utilizável",
    proximaEtapa: "todos os provedores responderam sem leitura aceita; reler repetiria a resposta — confira o post e registre à mão",
  },
  leitura_recusada_com_provedor_fora: {
    classe: "recurso_externo",
    rotulo: "a IA que leu recusou, e outro provedor não voltou a tempo",
    proximaEtapa: "as tentativas acabaram com parte dos provedores fora e os que leram sem aposta aceita — confira o post; se era aposta, use \"Capturar mesmo assim\" quando eles voltarem ou registre à mão",
  },
  unsupported_trading_terms: {
    classe: "legenda_incompleta",
    rotulo: "lay, responsabilidade, comissão ou cash-out parcial sem contrato financeiro próprio",
    proximaEtapa: "não registre esta operação como aposta a favor; o cálculo de responsabilidade, comissão e exposição residual ainda não é suportado. Uma cobertura a favor com stake e odd próprias pode ser registrada separadamente",
  },
  unsupported_promotion_terms: {
    classe: "legenda_incompleta",
    rotulo: "bilhete com freebet, bônus ou regra promocional sem cálculo financeiro próprio",
    proximaEtapa: "confira os termos da casa; estes bilhetes ainda não podem ser registrados como stake em dinheiro. Bônus em Contas é apenas crédito já disponível em dinheiro",
  },
  leitura_nao_mapeada: {
    classe: "legenda_incompleta",
    rotulo: "leitura da IA que não virou aposta",
    proximaEtapa: "a IA devolveu campos que não formam uma aposta registrável — confira o post e registre à mão",
  },
  imagem_original_indisponivel: {
    classe: "recurso_externo",
    rotulo: "imagem original indisponível",
    proximaEtapa: "a mídia sumiu do Telegram antes da leitura — reenviar o post recaptura",
  },
  [MOTIVO_SEM_REGISTRO]: {
    classe: "legenda_incompleta",
    rotulo: "recusada sem motivo gravado",
    proximaEtapa: "a recusa não disse por quê — ver `recordParseTelemetry`",
  },
} as const;

/** Rótulo em português de um motivo, para aviso e pendência. */
export function rotuloDoMotivo(motivo: string): string {
  return MOTIVOS_DE_PERDA[motivo]?.rotulo ?? motivo.replaceAll("_", " ");
}

/** Perdas que contam contra o RENDIMENTO do motor. As outras são ruído do funil. */
export const CLASSES_QUE_SAO_FALHA: readonly ClasseDePerda[] = [
  "legenda_incompleta",
  "recurso_externo",
] as const;

/**
 * Classes em que não HÁ o que fazer: o motor acertou ao recusar, ou a decisão
 * foi do operador. Todas as outras devem dizer a próxima etapa — a lista é
 * declarada aqui para que classe nova nasça exigindo-a, em vez de o portão
 * abrir uma exceção nova a cada vez.
 */
export const CLASSES_SEM_PROXIMA_ETAPA: readonly ClasseDePerda[] = [
  "descarte_correto",
  "decisao_do_operador",
] as const;

/** `audit_events.outcome` de post que produziu aposta. */
export const DESFECHO_GRAVADO = "registered";
/** O post aponta para uma aposta que já existia — também é post capturado. */
export const DESFECHO_REPETIDO = "duplicate";

export type Perda = {
  readonly motivo: string;
  readonly rotulo: string;
  readonly classe: ClasseDePerda;
  readonly proximaEtapa: string;
  readonly n: number;
};

/**
 * Um desfecho de POST, já resolvido a partir dos eventos daquele post.
 *
 * O tipo é a defesa: não há como passar "linhas de auditoria" para cá sem
 * antes decidir, post a post, se ele foi capturado. A soma de eventos não cabe
 * nesta assinatura.
 */
export type ContagemDePosts = {
  /** Algum evento do post gravou (ou apontou para) aposta. */
  readonly capturado: boolean;
  /** Motivo do ÚLTIMO veredito. Só é lido quando `capturado` é falso. */
  readonly motivo: string | null;
  /** Quantos posts caíram nesse desfecho. */
  readonly n: number;
};

export type RendimentoDoMotor = {
  /** Posts julgados pelo parser. Um post, uma unidade — nunca um evento. */
  readonly posts: number;
  readonly gravadas: number;
  /** Descarte correto, FORA do denominador. */
  readonly descartadas: number;
  /** Posts que eram aposta de verdade: `posts − descartadas`. */
  readonly tentativas: number;
  /** Perdas que contam como falha do motor. */
  readonly perdidas: number;
  /** `gravadas ÷ tentativas`, em %. `null` quando não houve tentativa. */
  readonly taxa: number | null;
  /** Por motivo, da maior para a menor. */
  readonly perdas: readonly Perda[];
  readonly motivosDesconhecidos: readonly string[];
};

/** Recusa nomeada quando a conta de uma etapa não fecha. */
export class FunilNaoFechaError extends Error {
  constructor(etapa: string, entrada: number, saida: number, perdas: number) {
    super(
      `Funil de captura não fecha na etapa "${etapa}": entraram ${entrada}, ` +
        `sobraram ${saida} e as perdas somam ${perdas}. ` +
        "Falta um balde — some as perdas ou corrija a medição antes de exibir.",
    );
    this.name = "FunilNaoFechaError";
  }
}

export function fecha(
  etapa: string,
  entrada: number,
  saida: number,
  perdas: readonly Perda[],
): void {
  const total = perdas.reduce((soma, perda) => soma + perda.n, 0);
  if (entrada !== saida + total) throw new FunilNaoFechaError(etapa, entrada, saida, total);
}

/**
 * O rendimento do motor sobre um conjunto de posts.
 *
 * Uma função, dois leitores. A conta FECHA (`tentativas = gravadas + perdidas`)
 * ou explode: se um motivo novo entrar com classe que não é falha nem descarte,
 * o rendimento passaria a descrever um conjunto diferente do que a tela conta,
 * e é melhor quebrar do que publicar.
 */
export function rendimentoDoMotor(desfechos: readonly ContagemDePosts[]): RendimentoDoMotor {
  let gravadas = 0;
  const porMotivo = new Map<string, number>();
  const desconhecidos = new Set<string>();

  for (const desfecho of desfechos) {
    const n = Math.max(0, Math.trunc(desfecho.n));
    if (n === 0) continue;
    if (desfecho.capturado) {
      gravadas += n;
      continue;
    }
    const motivo = desfecho.motivo?.trim() || MOTIVO_SEM_REGISTRO;
    if (!MOTIVOS_DE_PERDA[motivo]) desconhecidos.add(motivo);
    porMotivo.set(motivo, (porMotivo.get(motivo) ?? 0) + n);
  }

  const perdas: Perda[] = [...porMotivo.entries()]
    .map(([motivo, n]) => {
      const verbete = MOTIVOS_DE_PERDA[motivo];
      return verbete
        ? { motivo, ...verbete, n }
        : {
            motivo,
            rotulo: motivo,
            classe: "legenda_incompleta" as const,
            proximaEtapa: "motivo sem verbete — ver `domain/recusa-de-captura`",
            n,
          };
    })
    .sort((a, b) => b.n - a.n || a.motivo.localeCompare(b.motivo));

  const soma = (classes: readonly ClasseDePerda[]): number =>
    perdas.reduce((total, perda) => (classes.includes(perda.classe) ? total + perda.n : total), 0);

  const descartadas = soma(["descarte_correto"]);
  const perdidas = soma(CLASSES_QUE_SAO_FALHA);
  const posts = gravadas + perdas.reduce((total, perda) => total + perda.n, 0);
  const tentativas = posts - descartadas;
  fecha(
    "Rendimento do motor",
    tentativas,
    gravadas,
    perdas.filter((perda) => perda.classe !== "descarte_correto"),
  );

  return {
    posts,
    gravadas,
    descartadas,
    tentativas,
    perdidas,
    taxa: tentativas > 0 ? (gravadas / tentativas) * 100 : null,
    perdas,
    motivosDesconhecidos: [...desconhecidos].sort(),
  };
}
