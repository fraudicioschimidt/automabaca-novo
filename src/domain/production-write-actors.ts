/**
 * Quem pode escrever em produção sem que o dono precise saber.
 *
 * Escrita direta de agente (liquidação, promoção de alias a `MANUAL`) não pode
 * passar invisível pela operação. Esta regra separa o fluxo automático e o
 * operador do painel de tudo o mais, que vira item de revisão.
 *
 * Lista de atores do fluxo automático: literais gravados pelo código em
 * `src/` e `app/` (grep `actor:`). Ator novo no código precisa entrar aqui,
 * senão aparece na revisão diária — é o lado seguro do erro.
 */
const AUTOMATIC_ACTOR_PATTERNS: readonly RegExp[] = [
  /^system(?::[a-z0-9-]+)?$/,
  /^worker$/,
  /^sport-resolver$/,
  /^ia_judge_auto$/,
  /^telegram-(?:channel|dm|reaction)(?::[^\s]+)?$/,
  /^telegram-user:[^\s]+$/,
  // Sessão temporária criada e revogada pela verificação de cada deploy.
  /^(?:[a-z0-9-]+-)?deployment-verification$/,
];

/**
 * `sport-resolver` é a reabertura por edição que o resolvedor de modalidade
 * faz ao confirmar o esporte; os demais atores automáticos não reabrem
 * liquidação e, como fonte, continuam indo para a revisão.
 */
const AUTOMATIC_SETTLEMENT_SOURCES: ReadonlySet<string> = new Set(["flashscore", "score", "sport-resolver"]);

/**
 * `agent:<nome>:por:<operador>` — escrita delegada e assumida (ex.: `ops-settle`).
 * Os scripts de operação exigem este formato do `--executor`; o grupo é o operador.
 */
export const DELEGATED_ACTOR = /^agent:[a-z0-9][a-z0-9-]{1,39}:por:([^\s:]+)$/;

const DELEGATED_ACTOR_PARTS = /^agent:([^:\s]+):por:([^:\s]+)$/;
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Como a tela mostra quem fez: o agente delegado vira "🤖 Gemini (por
 * Fabricio)"; o resto sai como foi gravado. Só exibição: a auditoria e as
 * regras continuam com o ator gravado.
 */
export function actorDisplayName(actor: string): string {
  const parts = DELEGATED_ACTOR_PARTS.exec(actor);
  return parts?.[1] && parts[2] ? `🤖 ${capitalized(parts[1])} (por ${capitalized(parts[2])})` : actor;
}

export type WriteOrigin = "automatic" | "operator" | "delegated" | "unattributed";

/** O ator que um script de agente precisa usar para a escrita aparecer como delegada. */
export function isDelegatedActor(actor: string): boolean {
  return DELEGATED_ACTOR.test(actor);
}

export function classifyAuditActor(actor: string, panelUsers: ReadonlySet<string>): WriteOrigin {
  if (panelUsers.has(actor)) return "operator";
  if (AUTOMATIC_ACTOR_PATTERNS.some((pattern) => pattern.test(actor))) return "automatic";
  // Só é "a pedido do operador" quando ele é usuário do painel: nome inventado
  // ou o `<dono>` copiado da instrução ficam como escrita sem autoria.
  const operator = DELEGATED_ACTOR.exec(actor)?.[1];
  if (operator && panelUsers.has(operator)) return "delegated";
  return "unattributed";
}

/** Quem liquidou, pela fonte: o `<x>` de `manual:<x>`/`ia-judge:<x>`; a fonte automática não tem ator. */
export function settlementSourceActor(source: string): string | undefined {
  return /^(?:manual|ia-judge):(.+)$/.exec(source)?.[1];
}

/** `manual:<x>`/`ia-judge:<x>` só são do painel quando `<x>` é um usuário real. */
export function classifySettlementSource(source: string, panelUsers: ReadonlySet<string>): WriteOrigin {
  if (AUTOMATIC_SETTLEMENT_SOURCES.has(source)) return "automatic";
  const match = /^(manual|ia-judge):(.+)$/.exec(source);
  if (!match?.[2]) return "unattributed";
  // `ia-judge:ia_judge_auto` é o ciclo automático; o ator já era automático,
  // a fonte da liquidação caía na revisão diária como escrita sem autoria.
  if (match[1] === "ia-judge" && classifyAuditActor(match[2], panelUsers) === "automatic") {
    return "automatic";
  }
  // O agente do dono homologando a sugestão (`ia-judge:agent:<nome>:por:<dono>`).
  if (match[1] === "ia-judge" && classifyAuditActor(match[2], panelUsers) === "delegated") return "delegated";
  if (panelUsers.has(match[2])) return "operator";
  return "unattributed";
}
