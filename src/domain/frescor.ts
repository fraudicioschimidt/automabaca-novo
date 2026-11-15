import { spRelative } from "@/src/domain/dates";

/**
 * SSOT do FRESCOR: de quando é o dado por trás de um número da tela.
 *
 * A renderização é no servidor; sem idade declarada, a tela não distingue "não
 * tem jogo agora" de "o bot morreu". Irmã de `cobertura-na-tela`: lá todo
 * número declara a BASE, aqui todo número declara a IDADE.
 *
 * O campo que decide tudo é `cadenciaMin`, porque existem dois relógios:
 *
 *  - `cadenciaMin != null` — relógio NOSSO. Um cron do `SCHEDULE_MANIFEST`
 *    promete rodar de N em N minutos. Passar da tolerância é FALHA e pode
 *    alarmar.
 *  - `cadenciaMin == null` — relógio do MUNDO. A tip chega quando o tipster
 *    posta; a linha de fechamento existe quando teve jogo. A idade é
 *    INFORMATIVA e nunca alarma.
 *
 * Confundir os dois faz "captura há 3 h" numa terça sem jogo virar vermelho, e
 * sinal que grita à toa o operador aprende a ignorar. Por isso `atrasada` é
 * impossível, pelo tipo, para fonte sem cadência (teste:
 * `tests/painel/frescor-na-tela.test.ts`). É também por que `fechamento` (o DADO,
 * `max(fetchedAt)`) e `cicloDeFechamento` (o JOB, `max(completed_on)` de
 * `closing.sync`) são fontes diferentes: um envelhece sem jogo, o outro quando
 * o worker para.
 */

export type ChaveDeFonte = "captura" | "fechamento" | "motor" | "cicloDeFechamento";

export type FonteDeFrescor = {
  chave: ChaveDeFonte;
  /** Prosa PT-BR exibida na tira. O portão exige que apareça em alguma tela. */
  rotulo: string;
  /**
   * Fila do `SCHEDULE_MANIFEST` que produz o instante, quando o relógio é
   * nosso. `null` quando quem manda é o mundo — e aí `cadenciaMin` também é.
   */
  fila: string | null;
  /**
   * Minutos entre execuções prometidas pelo cron. `null` = sem cadência.
   * O portão confere contra o cron REAL do manifesto: apertar a cadência de um
   * job sem revisar aqui reprova, em vez de virar um limiar mentiroso.
   */
  cadenciaMin: number | null;
  /**
   * O que se escreve quando o instante nunca existiu. Frase INTEIRA, e não um
   * complemento: a tira compõe `rotulo + texto` no caso normal ("captura há
   * 1 h") e usa esta sozinha no caso vazio — "captura nenhuma aposta" não é
   * português.
   */
  textoSemDado: string;
};

/**
 * Quantos ciclos perdidos até chamar de atraso.
 *
 * Três, e não é número escolhido: com o heartbeat a cada 5 min, três ciclos dão
 * exatamente os 15 min de `WORKER_HEARTBEAT_STALE_MIN`, que a API, o monitor e
 * o painel já usam. A tolerância é consequência da cadência, não uma segunda
 * verdade a manter sincronizada — e o teste trava as duas juntas.
 */
export const TOLERANCIA_DE_CICLOS = 3;

export const FONTES_DE_FRESCOR: readonly FonteDeFrescor[] = [
  {
    chave: "captura",
    rotulo: "captura",
    fila: null,
    cadenciaMin: null,
    textoSemDado: "nenhuma aposta ainda",
  },
  {
    chave: "fechamento",
    rotulo: "fechamento",
    fila: null,
    cadenciaMin: null,
    textoSemDado: "nenhum fechamento ainda",
  },
  {
    chave: "motor",
    rotulo: "motor",
    fila: "health.heartbeat",
    cadenciaMin: 5,
    textoSemDado: "sem heartbeat",
  },
  {
    chave: "cicloDeFechamento",
    rotulo: "ciclo de fechamento",
    fila: "closing.sync",
    cadenciaMin: 5,
    textoSemDado: "ciclo de fechamento nunca rodou",
  },
];

const PorChave = new Map(FONTES_DE_FRESCOR.map((f) => [f.chave, f]));

export function fonteDeFrescor(chave: ChaveDeFonte): FonteDeFrescor {
  const fonte = PorChave.get(chave);
  if (!fonte) throw new Error(`Fonte de frescor desconhecida: ${chave}`);
  return fonte;
}

/** Minutos tolerados antes de `atrasada`. `null` quando o relógio é do mundo. */
export function toleranciaMin(fonte: FonteDeFrescor): number | null {
  return fonte.cadenciaMin == null ? null : fonte.cadenciaMin * TOLERANCIA_DE_CICLOS;
}

/**
 * Tolerância de uma fonte que PROMETEU cadência — lança se ela não prometeu.
 *
 * Existe para que `WORKER_HEARTBEAT_STALE_MIN` seja DERIVADO da cadência em vez
 * de um segundo 15 escrito à mão: um `?? 15` no chamador traria o literal de
 * volta pela porta dos fundos, que é exatamente o defeito que o portão
 * `cadencia-vs-portoes` persegue.
 */
export function toleranciaDeCadencia(chave: ChaveDeFonte): number {
  const fonte = fonteDeFrescor(chave);
  const tolerancia = toleranciaMin(fonte);
  if (tolerancia == null) {
    throw new Error(`Fonte de frescor "${chave}" não declara cadência — não há tolerância a derivar.`);
  }
  return tolerancia;
}

/**
 * De quanto em quanto tempo o carimbo se recalcula no navegador.
 *
 * Carimbo renderizado só no servidor congela com a aba aberta — pior que não
 * ter carimbo. O valor precisa ser MENOR que a menor unidade que `spRelative`
 * distingue (um minuto), senão o texto pularia de "agora" para "há 2 min";
 * `tests/painel/frescor-na-tela.test.ts` mede essa resolução.
 */
export const CADENCIA_DO_CARIMBO_MS = 30_000;

export type Frescor = {
  chave: ChaveDeFonte;
  rotulo: string;
  /** `null` quando o instante nunca existiu. */
  idadeMin: number | null;
  /**
   * O INSTANTE do dado, já com o clamp aplicado — em ISO porque atravessa a
   * fronteira servidor→cliente. É o que permite ao carimbo envelhecer: com
   * apenas `texto`, o navegador não teria de onde recalcular e a frase ficaria
   * congelada na hora do render.
   */
  emISO: string | null;
  /** "há 12 min" / "agora" / o `textoSemDado` da fonte. */
  texto: string;
  /** Só pode ser `true` para fonte COM cadência. */
  atrasada: boolean;
};

/**
 * Idade e veredito, calculados de UMA leitura do relógio.
 *
 * O texto e a decisão saem do MESMO `idadeMin` de propósito: dois consumidores
 * recalculando a mesma grandeza por caminhos diferentes fazem a tela exibir um
 * número que contradiz o próprio selo ao lado.
 */
export function frescorDaFonte(
  fonte: FonteDeFrescor,
  quando: Date | null | undefined,
  agora: Date,
): Frescor {
  const t = quando?.getTime();
  if (t == null || !Number.isFinite(t)) {
    return {
      chave: fonte.chave,
      rotulo: fonte.rotulo,
      idadeMin: null,
      emISO: null,
      texto: fonte.textoSemDado,
      // Nunca ter rodado É atraso para quem prometeu cadência (é o que
      // `workerVivo` já decide com heartbeat nulo). Para o relógio do mundo,
      // "nenhuma aposta ainda" não é defeito de ninguém.
      atrasada: fonte.cadenciaMin != null,
    };
  }
  // Instante no FUTURO vira "agora", e o clamp acontece ANTES de o texto ser
  // formatado — não depois, em cada consumidor. Desvio de relógio entre o
  // Postgres e o processo é real e pequeno; sem clamp aqui, `idadeMin` sairia 0
  // e `texto` sairia "em 3 min", a mesma grandeza dizendo duas coisas na mesma
  // linha.
  const instante = Math.min(t, agora.getTime());
  const idadeMin = Math.floor((agora.getTime() - instante) / 60_000);
  const tolerancia = toleranciaMin(fonte);
  return {
    chave: fonte.chave,
    rotulo: fonte.rotulo,
    idadeMin,
    emISO: new Date(instante).toISOString(),
    texto: spRelative(new Date(instante), agora),
    atrasada: tolerancia != null && idadeMin > tolerancia,
  };
}
