import { Prisma, type CapturePolicy, type SharpMode } from "@/src/generated/prisma/client";
import { MAX_BANKROLL_SLUG_LENGTH } from "@/src/domain/bankroll-identity";
import { roundMoney } from "@/src/domain/money";
import type { NoOddsReason } from "@/src/domain/no-odds-reason";
import { slugify } from "@/src/domain/text";
import { canonicalSport } from "@/src/domain/sports/registry";
import { validateCaptureStakeSettings, type CaptureStakeSettings } from "@/src/domain/capture-stake-policy";
import { telegramChannelActor, telegramChannelSource } from "@/src/domain/telegram-source";
import { prisma } from "@/src/infra/prisma";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";
import { prepareCreationRequest, findCreationReceiptTx, recordCreationReceiptTx } from "@/src/services/shared/creation-receipt";
import { reuseSerializableTransaction, runSerializableTransaction, type SerializableTransactionClient } from "@/src/services/shared/transaction";

/** CRUD de bankrolls — canal Telegram único, slug estável enquanto ativo. */

const MAX_BANKROLL_NAME_LENGTH = 120;
const MAX_BOOKMAKER_LENGTH = 100;
const MAX_UNIT_VALUE = 99_999_999.99;
const MAX_CAPITAL_VALUE = 9_999_999_999.99;
const POSTGRES_BIGINT_MIN = -9_223_372_036_854_775_808n;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

export type BankrollInput = CaptureStakeSettings & {
  nome: string;
  valorUnidade: number;
  capitalInicial: number;
  sharpMode: SharpMode;
  /** De onde vem a odd autoritativa na captura deste canal. */
  capturePolicy: CapturePolicy;
  vincularContas: boolean;
  telegramChannelId?: string | null;
  defaultBookmaker?: string | null;
  /** Esportes que o canal posta; vazio = "vários/não sei". */
  channelSports?: readonly string[];
};

function parseChannelId(raw: string | null | undefined): bigint | null {
  const t = raw?.trim();
  if (!t) return null;
  if (!/^-?\d{5,20}$/.test(t)) {
    throw new RecusaDeNegocioError("channelId inválido — use o ID numérico do canal (ex.: -1001234567890).");
  }
  const channelId = BigInt(t);
  if (channelId < POSTGRES_BIGINT_MIN || channelId > POSTGRES_BIGINT_MAX) {
    throw new RecusaDeNegocioError("channelId inválido — o ID excede o limite numérico suportado.");
  }
  return channelId;
}

function normalizarNome(raw: string): string {
  const nome = raw.trim();
  if (!nome) throw new RecusaDeNegocioError("Nome é obrigatório.");
  if (nome.length > MAX_BANKROLL_NAME_LENGTH) {
    throw new RecusaDeNegocioError(`Nome excede ${MAX_BANKROLL_NAME_LENGTH} caracteres.`);
  }
  return nome;
}

function normalizarValorUnidade(raw: number): number {
  if (!Number.isFinite(raw)) throw new RecusaDeNegocioError("Valor da unidade inválido.");
  const valorUnidade = roundMoney(raw, 2);
  if (valorUnidade <= 0 || valorUnidade > MAX_UNIT_VALUE) {
    throw new RecusaDeNegocioError("Valor da unidade inválido.");
  }
  return valorUnidade;
}

function normalizarCapitalInicial(raw: number): number {
  if (!Number.isFinite(raw)) throw new RecusaDeNegocioError("Capital inicial inválido.");
  const capitalInicial = roundMoney(raw, 2);
  if (capitalInicial < 0 || capitalInicial > MAX_CAPITAL_VALUE) {
    throw new RecusaDeNegocioError("Capital inicial inválido.");
  }
  return capitalInicial;
}

function normalizarBookmaker(raw: string | null | undefined): string | null {
  const defaultBookmaker = raw?.trim() || null;
  if (defaultBookmaker && defaultBookmaker.length > MAX_BOOKMAKER_LENGTH) {
    throw new RecusaDeNegocioError(`Casa padrão excede ${MAX_BOOKMAKER_LENGTH} caracteres.`);
  }
  return defaultBookmaker;
}

/** Nomes canônicos do registro, sem repetição; nome desconhecido é erro de quem chamou. */
function normalizeChannelSports(raw: readonly string[]): string[] {
  const sports = raw.map((value) => {
    const sport = canonicalSport(value);
    if (!sport) throw new RecusaDeNegocioError(`Esporte desconhecido: ${value}`);
    return sport;
  });
  return [...new Set(sports)];
}

/** A política de stake é preenchida pelo operador: o que ela recusa é recusa de negócio. */
function stakeSettingsOrRefuse(settings: Parameters<typeof validateCaptureStakeSettings>[0]) {
  try {
    return validateCaptureStakeSettings(settings);
  } catch (error) {
    throw new RecusaDeNegocioError(error instanceof Error ? error.message : String(error));
  }
}

function normalizar(input: BankrollInput): BankrollInput {
  return {
    ...input,
    ...stakeSettingsOrRefuse(input),
    nome: normalizarNome(input.nome),
    valorUnidade: normalizarValorUnidade(input.valorUnidade),
    capitalInicial: normalizarCapitalInicial(input.capitalInicial),
    defaultBookmaker: normalizarBookmaker(input.defaultBookmaker),
    channelSports: normalizeChannelSports(input.channelSports ?? []),
  };
}

async function assertCanalLivre(
  db: Prisma.TransactionClient,
  channelId: bigint | null,
  ignorarId?: string,
): Promise<void> {
  if (channelId === null) return;
  const dono = await db.bankroll.findFirst({
    where: {
      telegramChannelId: channelId,
      ...(ignorarId ? { id: { not: ignorarId } } : {}),
    },
    select: { nome: true },
  });
  if (dono) throw new RecusaDeNegocioError(`Canal já mapeado para "${dono.nome}".`);
}

export async function criarBankroll(
  input: BankrollInput,
  actor = "system",
  options?: { requestId?: string; client?: SerializableTransactionClient },
): Promise<{ id: string; slug: string }> {
  const normalized = normalizar(input);
  const base = slugify(normalized.nome).slice(0, MAX_BANKROLL_SLUG_LENGTH).replace(/-+$/, "") || "banca";
  const channelId = parseChannelId(normalized.telegramChannelId);
  const request = prepareCreationRequest("bankroll.create", actor, options?.requestId, {
    nome: normalized.nome, valorUnidade: normalized.valorUnidade, capitalInicial: normalized.capitalInicial,
    sharpMode: normalized.sharpMode, capturePolicy: normalized.capturePolicy, stakePolicy: normalized.stakePolicy,
    defaultStakeUnits: normalized.defaultStakeUnits ?? null, vincularContas: normalized.vincularContas,
    telegramChannelId: channelId?.toString() ?? null, defaultBookmaker: normalized.defaultBookmaker ?? null,
    channelSports: [...(normalized.channelSports ?? [])].sort(),
  });
  return runSerializableTransaction("criarBankroll", async (tx) => {
    const existingId = await findCreationReceiptTx(tx, request);
    if (existingId) {
      const existing = await tx.bankroll.findUnique({ where: { id: existingId }, select: { id: true, slug: true } });
      if (!existing) throw new RecusaDeNegocioError("Esta criação já foi concluída e o tipster foi excluído. Abra um novo formulário.");
      return existing;
    }
    await assertCanalLivre(tx, channelId);
    // O sufixo participa do limite aceito pelo painel; o nome continua inteiro.
    let slug = base;
    for (let i = 2; await tx.bankroll.findUnique({ where: { slug } }); i++) {
      const suffix = `-${i}`;
      slug = `${base.slice(0, MAX_BANKROLL_SLUG_LENGTH - suffix.length).replace(/-+$/, "")}${suffix}`;
    }
    const created = await tx.bankroll.create({
      data: {
        nome: normalized.nome,
        slug,
        valorUnidade: normalized.valorUnidade,
        capitalInicial: normalized.capitalInicial,
        sharpMode: normalized.sharpMode,
        capturePolicy: normalized.capturePolicy,
        stakePolicy: normalized.stakePolicy,
        defaultStakeUnits: normalized.defaultStakeUnits,
        vincularContas: normalized.vincularContas,
        telegramChannelId: channelId,
        defaultBookmaker: normalized.defaultBookmaker,
        channelSports: [...(normalized.channelSports ?? [])],
      },
      select: { id: true, slug: true },
    });
    await tx.auditEvent.create({
      data: {
        actor,
        action: "bankroll.create",
        resource: "bankroll",
        resourceId: created.id,
        details: {
          nome: normalized.nome,
          slug,
          sharpMode: normalized.sharpMode,
          capturePolicy: normalized.capturePolicy,
          stakePolicy: normalized.stakePolicy,
          defaultStakeUnits: normalized.defaultStakeUnits,
          telegramChannelId: channelId === null ? null : String(channelId),
        },
      },
    });
    await recordCreationReceiptTx(tx, request, created.id);
    return created;
  }, { client: options?.client });
}

/** Configuração da banca que nasce sozinha no primeiro post de um canal; o dono ajusta em Config. */
export const CHANNEL_BANKROLL_DEFAULTS = {
  valorUnidade: 100,
  capitalInicial: 100,
  sharpMode: "CLV_ONLY",
  capturePolicy: "AUTO",
  stakePolicy: "MESSAGE",
  defaultStakeUnits: null,
  vincularContas: true,
  defaultBookmaker: null,
  // "Vários/não sei": o dono marca os esportes em Config quando conhecer o canal.
  channelSports: [],
} as const satisfies Omit<BankrollInput, "nome" | "telegramChannelId">;

const CHANNEL_BANKROLL_ACTOR = telegramChannelActor("auto-bankroll");

/**
 * O dono já tirou este canal de uma banca (excluindo a banca ou apagando o
 * canal dela): recriar sozinho desfaria a decisão dele.
 */
export async function isChannelRetiredByOwner(chatId: bigint, client: Prisma.TransactionClient = prisma): Promise<boolean> {
  const channel = String(chatId);
  const [retiredSource, audit] = await Promise.all([
    client.retiredBetSource.findFirst({ where: { source: telegramChannelSource(chatId) }, select: { retiredBetId: true } }),
    client.auditEvent.findFirst({
      where: {
        OR: [
          { action: "bankroll.delete", details: { path: ["telegramChannelIds"], array_contains: [channel] } },
          { action: "bankroll.update", details: { path: ["previousTelegramChannelId"], equals: channel } },
        ],
      },
      select: { id: true },
    }),
  ]);
  return retiredSource !== null || audit !== null;
}

/**
 * Cria a banca de um canal que ainda não tem. Dois posts do mesmo canal ao
 * mesmo tempo esbarram no `telegramChannelId` único: quem perde encontra a
 * banca do outro e segue a captura com ela.
 */
export async function createChannelBankroll(params: { chatId: bigint; title: string }): Promise<
  | { kind: "created"; id: string; slug: string; nome: string }
  | { kind: "existing" }
  | { kind: "retired" }
> {
  const nome = params.title.trim().slice(0, MAX_BANKROLL_NAME_LENGTH).trim() || `Canal ${params.chatId}`;
  try {
    return await runSerializableTransaction("createChannelBankroll", async (tx) => {
      // A leitura da retirada participa da transação que cria o cadastro.
      if (await isChannelRetiredByOwner(params.chatId, tx)) return { kind: "retired" as const };
      const created = await criarBankroll(
        { ...CHANNEL_BANKROLL_DEFAULTS, nome, telegramChannelId: String(params.chatId) },
        CHANNEL_BANKROLL_ACTOR,
        { client: reuseSerializableTransaction(tx) },
      );
      return { kind: "created" as const, ...created, nome };
    });
  } catch (err) {
    const winner = await prisma.bankroll.findFirst({ where: { telegramChannelId: params.chatId }, select: { id: true } });
    if (winner) return { kind: "existing" };
    throw err;
  }
}

/**
 * A banca sai de um modo que não mede CLV: o jogo que começou nele fechou sem
 * medição. Quando a banca voltar a medir, o `closing.sync` o congelaria como
 * captura que faltou (`kickoff_sem_captura`, falha do sistema). Congela na
 * troca, com o motivo do modo de então, que tira a aposta da base da cobertura
 * e da busca do fechamento pós-jogo. Em cadeia (IDENTITY_ONLY → OFF → CLV_ONLY)
 * cada troca congela o período do modo que saiu.
 */
async function freezeUnmeasuredClosings(
  tx: Prisma.TransactionClient,
  bankrollId: string,
  previous: { sharpMode: SharpMode; sharpModeChangedAt: Date | null },
  changedAt: Date,
): Promise<void> {
  const reason: NoOddsReason = previous.sharpMode === "IDENTITY_ONLY" ? "identity_only" : "sharp_off";
  // O jogo de antes do modo anterior começou em outro modo e segue o caminho dele.
  const since = previous.sharpModeChangedAt;
  // Kickoff provisório (hora do post, ou 00:00 do dia) fica no passado mesmo
  // com o jogo por vir; o calendário o corrige. O esporte pendente entra: o
  // motivo é o modo da banca, que não depende do esporte.
  await tx.$executeRaw`
    INSERT INTO bet_closing ("betId", "fetchedAt", "clvReliable", "noOddsReason", "source", "updatedAt")
    SELECT b.id, ${changedAt}, false, ${reason}, 'CRON'::"ClosingSource", now()
    FROM bets b
    WHERE b."bankrollId" = ${bankrollId} AND b."deletedAt" IS NULL AND b."kickoffInferido" = false
      AND b.data <= ${changedAt}
      AND (${since}::timestamptz IS NULL OR b.data > ${since}::timestamptz)
    ON CONFLICT ("betId") DO UPDATE
      SET "fetchedAt" = EXCLUDED."fetchedAt", "clvReliable" = false,
        "noOddsReason" = EXCLUDED."noOddsReason", "updatedAt" = now()
      WHERE bet_closing."fetchedAt" IS NULL
  `;
}

/**
 * Edição PARCIAL: campo ausente não é tocado. Exigir o shape completo faria a
 * tela devolver valores lidos fora da transação e sobrescrever uma edição
 * concorrente. Quem não edita, não envia.
 */
export type BankrollEditInput = Partial<BankrollInput> & {
  /** Pausa (true) ou retoma (false) a captura do canal. */
  capturePaused?: boolean;
};

/**
 * Edita a banca. Devolve se os esportes do canal mudaram de verdade: as
 * apostas dele ainda sem esporte precisam ser reavaliadas com a marcação nova.
 */
export async function editarBankroll(
  id: string,
  input: BankrollEditInput,
  actor = "system",
): Promise<{ channelSportsChanged: boolean }> {
  const normalized = {
    ...(input.nome !== undefined ? { nome: normalizarNome(input.nome) } : {}),
    ...(input.valorUnidade !== undefined
      ? { valorUnidade: normalizarValorUnidade(input.valorUnidade) }
      : {}),
    ...(input.sharpMode !== undefined ? { sharpMode: input.sharpMode } : {}),
    ...(input.capturePolicy !== undefined
      ? { capturePolicy: input.capturePolicy }
      : {}),
    ...(input.capitalInicial !== undefined
      ? { capitalInicial: normalizarCapitalInicial(input.capitalInicial) }
      : {}),
    ...(input.vincularContas !== undefined
      ? { vincularContas: input.vincularContas }
      : {}),
    ...(input.defaultBookmaker !== undefined
      ? { defaultBookmaker: normalizarBookmaker(input.defaultBookmaker) }
      : {}),
    ...(input.telegramChannelId !== undefined
      ? { telegramChannelId: parseChannelId(input.telegramChannelId) }
      : {}),
    ...(input.channelSports !== undefined
      ? { channelSports: normalizeChannelSports(input.channelSports) }
      : {}),
  };
  return runSerializableTransaction("editarBankroll", async (tx) => {
    // Existência DENTRO da transação, não na tela com um read solto: banca
    // inexistente precisa virar mensagem acionável, não P2025 cru.
    const existe = await tx.bankroll.findFirst({
      where: { id },
      select: {
        id: true, stakePolicy: true, defaultStakeUnits: true, telegramChannelId: true, capturePausedAt: true,
        sharpMode: true, sharpModeChangedAt: true, channelSports: true,
      },
    });
    if (!existe) throw new RecusaDeNegocioError(`Tipster ${id} não encontrado.`);
    const stakePatch = input.stakePolicy !== undefined || input.defaultStakeUnits !== undefined
      ? stakeSettingsOrRefuse({ stakePolicy: input.stakePolicy ?? existe.stakePolicy, defaultStakeUnits: input.defaultStakeUnits !== undefined ? input.defaultStakeUnits : existe.defaultStakeUnits === null ? null : Number(existe.defaultStakeUnits) })
      : {};
    if (normalized.telegramChannelId !== undefined) {
      await assertCanalLivre(tx, normalized.telegramChannelId, id);
    }
    // Pausar de novo não troca o instante: ele diz desde quando o canal está parado.
    const pausePatch = input.capturePaused === undefined ? {}
      : input.capturePaused ? { capturePausedAt: existe.capturePausedAt ?? new Date() }
        : { capturePausedAt: null };
    // O formulário sempre manda o modo: só a troca de verdade invalida os preços guardados.
    const modeChangedAt = normalized.sharpMode !== undefined && normalized.sharpMode !== existe.sharpMode
      ? new Date() : null;
    const modePatch = modeChangedAt ? { sharpModeChangedAt: modeChangedAt } : {};
    await tx.bankroll.update({
      where: { id },
      data: { ...normalized, ...stakePatch, ...pausePatch, ...modePatch },
    });
    if (modeChangedAt && existe.sharpMode !== "CLV_ONLY") {
      await freezeUnmeasuredClosings(tx, id, existe, modeChangedAt);
    }
    await tx.auditEvent.create({
      data: {
        actor,
        action: "bankroll.update",
        resource: "bankroll",
        resourceId: id,
        details: {
          nome: normalized.nome,
          sharpMode: normalized.sharpMode,
          capturePolicy: normalized.capturePolicy,
          ...stakePatch,
          ...(normalized.channelSports !== undefined ? { channelSports: normalized.channelSports } : {}),
          ...(input.capturePaused !== undefined && Boolean(existe.capturePausedAt) !== input.capturePaused
            ? { capturePaused: input.capturePaused }
            : {}),
          // Canal que sai da banca não ganha banca nova sozinho (isChannelRetiredByOwner).
          ...(normalized.telegramChannelId !== undefined && existe.telegramChannelId !== null
            && normalized.telegramChannelId !== existe.telegramChannelId
            ? { previousTelegramChannelId: String(existe.telegramChannelId) }
            : {}),
        },
      },
    });
    const before = [...existe.channelSports].sort().join(",");
    const after = normalized.channelSports === undefined ? before : [...normalized.channelSports].sort().join(",");
    return { channelSportsChanged: after !== before };
  });
}

type BankrollPermanentDeleteDependencies = {
  betIds: string[];
  retiredSources: number;
  trainingCases: number;
  operationalActions: number;
  auditEvents: number;
  cooldowns: number;
  teamNameWaits: number;
  captureFixDrafts: number;
  mediaAlbums: number;
};

/**
 * Preserva somente a chave técnica necessária para uma reentrega externa não
 * ressuscitar a aposta e remove todas as cópias operacionais sem FK.
 *
 * Relações reais de Bet/Bankroll seguem pelo cascade do schema. AuditEvent e
 * OperationalAction são referências genéricas; sem esta varredura, evento,
 * seleção e evidência continuariam reconstruíveis depois do hard-delete.
 */
async function excluirDependenciasDaBancaTx(
  tx: Prisma.TransactionClient,
  bankrollId: string,
  telegramChannelIds: readonly string[],
  now = new Date(),
): Promise<BankrollPermanentDeleteDependencies> {
  const bets = await tx.bet.findMany({
    where: { bankrollId },
    select: { id: true, source: true, sourceExternalId: true },
  });
  const betIds = bets.map((bet) => bet.id);
  const sources = bets.flatMap((bet) => bet.sourceExternalId
    ? [{
        source: bet.source,
        sourceExternalId: bet.sourceExternalId,
        retiredBetId: bet.id,
        retiredAt: now,
      }]
    : []);
  if (betIds.length > 0) {
    const absorbed = await tx.absorbedBetSource.findMany({ where: { betId: { in: betIds } },
      select: { source: true, sourceExternalId: true, betId: true } });
    sources.push(...absorbed.map((row) => ({ source: row.source, sourceExternalId: row.sourceExternalId, retiredBetId: row.betId, retiredAt: now })));
    const legacy = await tx.auditEvent.findMany({ where: { action: "bet.duplicate_absorbed", resource: "bet", resourceId: { in: betIds } },
      select: { resourceId: true, details: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    for (const row of legacy) {
      const details = row.details as { source?: unknown; sourceExternalId?: unknown } | null;
      if (row.resourceId && typeof details?.source === "string" && details.source &&
          typeof details.sourceExternalId === "string" && details.sourceExternalId) {
        sources.push({ source: details.source, sourceExternalId: details.sourceExternalId, retiredBetId: row.resourceId, retiredAt: now });
      }
    }
  }
  const retiredSources = sources.length > 0
    ? (await tx.retiredBetSource.createMany({ data: sources, skipDuplicates: true })).count
    : 0;

  const training = betIds.length > 0
    ? await tx.trainingCase.findMany({
        where: { betId: { in: betIds } },
        select: { id: true },
      })
    : [];
  const trainingIds = training.map((row) => row.id);

  const actionOr: Prisma.OperationalActionWhereInput[] = [
    { resource: "bankroll", resourceId: bankrollId },
  ];
  if (betIds.length > 0) {
    actionOr.push({ resource: { in: ["bet", "bet_sharp"] }, resourceId: { in: betIds } });
  }
  if (trainingIds.length > 0) {
    actionOr.push({ resource: "training-case", resourceId: { in: trainingIds } });
  }
  // Pendência de post (`<chatId>:<messageId>`: revisão de captura, conserto
  // pela DM) guarda a legenda e a leitura, e nada a fecha depois. O canal que
  // hoje é de outra banca fica com as dele.
  const channelsElsewhere = telegramChannelIds.length > 0
    ? await tx.bankroll.findMany({
        where: { telegramChannelId: { in: telegramChannelIds.map((id) => BigInt(id)) }, id: { not: bankrollId } },
        select: { telegramChannelId: true },
      })
    : [];
  const keptChannels = new Set(channelsElsewhere.map((row) => String(row.telegramChannelId)));
  for (const chatId of telegramChannelIds) {
    if (!keptChannels.has(chatId)) {
      actionOr.push({ resource: "telegram-channel", resourceId: { startsWith: `${chatId}:` } });
    }
  }
  const actions = await tx.operationalAction.findMany({
    where: { OR: actionOr },
    select: { id: true },
  });
  const actionIds = actions.map((row) => row.id);

  const auditOr: Prisma.AuditEventWhereInput[] = [
    { resource: "bankroll", resourceId: bankrollId },
    // Arquivo dos posts descartados desta banca (`channel-post-archive`): o
    // texto do post e a aposta que o guard recusou.
    { action: "canal_post_descartado", resource: "telegram_message", details: { path: ["bankrollId"], equals: bankrollId } },
  ];
  if (betIds.length > 0) {
    auditOr.push(
      { resource: { in: ["bet", "bet_sharp"] }, resourceId: { in: betIds } },
      // Os dois checks históricos de consistência gravam o betId em `resource`
      // e usam o dia em `resourceId`; cobrir a forma antiga evita deixar uma
      // segunda cópia só porque o writer precede a convenção canônica.
      { resource: { in: betIds }, action: { in: ["bet_lucro_drift", "bet_ledger_drift"] } },
    );
  }
  if (trainingIds.length > 0) {
    auditOr.push({ resource: "training_case", resourceId: { in: trainingIds } });
  }
  if (actionIds.length > 0) {
    auditOr.push({ resource: "operational_action", resourceId: { in: actionIds } });
  }
  // A conciliação por conta usa aposta:conta como resource. O prefixo inteiro
  // identifica a aposta sem alcançar o histórico financeiro de outro tipster.
  const ledgerAuditEvents = betIds.length > 0 ? await tx.$executeRaw`
    DELETE FROM audit_events
    WHERE action = 'bet_ledger_drift'
      AND split_part(resource, ':', 1) = ANY(${betIds}::text[])
  ` : 0;
  const auditEvents = ledgerAuditEvents + (await tx.auditEvent.deleteMany({ where: { OR: auditOr } })).count;
  const operationalActions = actions.length > 0
    ? (await tx.operationalAction.deleteMany({ where: { id: { in: actionIds } } })).count
    : 0;
  const trainingCases = training.length > 0
    ? (await tx.trainingCase.deleteMany({ where: { id: { in: trainingIds } } })).count
    : 0;

  const cooldownKeys = betIds.flatMap((betId) => [
    `bet:${betId}`,
    `training-review:${betId}`,
    `kickoff-bridge:${betId}`,
    `kickoff-web:${betId}`,
  ]);
  const cooldowns = cooldownKeys.length > 0
    ? (await tx.iaJudgeCooldown.deleteMany({ where: { key: { in: cooldownKeys } } })).count
    : 0;

  const teamNameWaits = betIds.length > 0
    ? (await tx.teamTipsterNameWait.deleteMany({ where: { betId: { in: betIds } } })).count
    : 0;
  const captureFixDrafts = (await tx.telegramDmDraft.deleteMany({
    where: { captureFix: { path: ["bankrollId"], equals: bankrollId } },
  })).count;
  const mediaAlbums = (await tx.telegramMediaAlbum.deleteMany({
    where: { chatId: { in: telegramChannelIds.filter((chatId) => !keptChannels.has(chatId)) } },
  })).count;

  return {
    betIds,
    retiredSources,
    trainingCases,
    operationalActions,
    auditEvents,
    cooldowns,
    teamNameWaits,
    captureFixDrafts,
    mediaAlbums,
  };
}

/**
 * Remove do ledger todos os efeitos financeiros das apostas de uma banca.
 *
 * `Movimentacao.bet` usa RESTRICT de propósito: apagar a aposta sem antes
 * reconciliar o dinheiro seria corrupção. As contas afetadas são travadas em
 * ordem estável, os lançamentos da banca somem e os snapshots restantes são
 * refeitos pela ordem canônica do ledger. Tudo roda na mesma transação
 * Serializable que apaga a banca.
 */
async function excluirEfeitosFinanceirosDaBancaTx(
  tx: Prisma.TransactionClient,
  bankrollId: string,
): Promise<number> {
  const contas = await tx.$queryRaw<Array<{ contaId: string }>>`
    SELECT DISTINCT m."contaId" AS "contaId"
    FROM movimentacoes m
    JOIN bets b ON b.id = m."betId"
    WHERE b."bankrollId" = ${bankrollId}
    ORDER BY m."contaId"
  `;

  for (const { contaId } of contas) {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM contas WHERE id = ${contaId} FOR UPDATE
    `;
  }

  await tx.$executeRaw`
    DELETE FROM movimentacoes m
    USING bets b
    WHERE m."betId" = b.id
      AND b."bankrollId" = ${bankrollId}
  `;

  for (const { contaId } of contas) {
    await tx.$executeRaw`
      WITH saldos AS (
        SELECT
          id,
          sum(valor) OVER (
            ORDER BY data ASC, "createdAt" ASC, id ASC
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS saldo
        FROM movimentacoes
        WHERE "contaId" = ${contaId}
      )
      UPDATE movimentacoes m
      SET "saldoApos" = saldos.saldo
      FROM saldos
      WHERE m.id = saldos.id
    `;
    await tx.$executeRaw`
      UPDATE contas c
      SET "saldoAtual" = COALESCE((
        SELECT sum(m.valor)
        FROM movimentacoes m
        WHERE m."contaId" = c.id
      ), 0)
      WHERE c.id = ${contaId}
    `;
  }

  return contas.length;
}

export type BankrollDeleteResult = {
  slug: string;
  auditId: string;
};

/** A banca ganhou ou perdeu apostas depois que a tela mostrou o total a apagar. */
export class BankrollBetCountChangedError extends RecusaDeNegocioError {
  readonly currentBetCount: number;
  constructor(expected: number, current: number) {
    super(
      `O tipster agora tem ${current} aposta${current === 1 ? "" : "s"}, não ${expected} como a tela mostrava. ` +
      "Confira o novo total e confirme a exclusão de novo.",
    );
    this.name = "BankrollBetCountChangedError";
    this.currentBetCount = current;
  }
}

/**
 * `expectedBetCount` é o total que o operador viu ao confirmar: a exclusão
 * apaga todas as apostas da banca, e uma captura chegando com o modal aberto
 * não pode sumir junto sem ele saber.
 */
export async function excluirBankroll(
  id: string,
  actor = "system",
  options: { expectedBetCount?: number } = {},
): Promise<BankrollDeleteResult | null> {
  return runSerializableTransaction("excluirBankroll", async (tx) => {
    const bankroll = await tx.bankroll.findUnique({
      where: { id },
      select: {
        id: true,
        nome: true,
        slug: true,
        telegramChannelId: true,
        _count: { select: { bets: true } },
      },
    });
    if (!bankroll) return null;
    if (options.expectedBetCount !== undefined && bankroll._count.bets !== options.expectedBetCount) {
      throw new BankrollBetCountChangedError(options.expectedBetCount, bankroll._count.bets);
    }

    // A limpeza abaixo apaga a auditoria da banca; os canais que já foram dela
    // seguem no evento de exclusão, que é o que impede recriá-los sozinhos.
    const unlinked = await tx.auditEvent.findMany({
      where: { action: "bankroll.update", resource: "bankroll", resourceId: bankroll.id, details: { path: ["previousTelegramChannelId"], not: Prisma.AnyNull } },
      select: { details: true },
    });
    const telegramChannelIds = [...new Set([
      ...(bankroll.telegramChannelId === null ? [] : [String(bankroll.telegramChannelId)]),
      ...unlinked.map((row) => String((row.details as { previousTelegramChannelId: string }).previousTelegramChannelId)),
    ])];

    const dependencias = await excluirDependenciasDaBancaTx(tx, bankroll.id, telegramChannelIds);
    const contasRecalculadas = await excluirEfeitosFinanceirosDaBancaTx(tx, bankroll.id);
    await tx.bankroll.delete({ where: { id: bankroll.id } });
    const audit = await tx.auditEvent.create({
      data: {
        actor,
        action: "bankroll.delete",
        resource: "bankroll",
        resourceId: id,
        // O mesmo evento é o outbox da limpeza de filesystem. Assim o banco
        // confirma o hard-delete uma vez só e o worker pode retomar a logo sem
        // manter uma segunda cópia operacional da banca.
        outcome: "pending",
        details: {
          nome: bankroll.nome,
          slug: bankroll.slug,
          apostasExcluidas: bankroll._count.bets,
          contasRecalculadas,
          fontesAposentadas: dependencias.retiredSources,
          casosDeTreinoExcluidos: dependencias.trainingCases,
          acoesOperacionaisExcluidas: dependencias.operationalActions,
          eventosDeAuditoriaExcluidos: dependencias.auditEvents,
          cooldownsExcluidos: dependencias.cooldowns,
          nomesAguardandoVinculoExcluidos: dependencias.teamNameWaits,
          rascunhosDeConsertoExcluidos: dependencias.captureFixDrafts,
          albunsExcluidos: dependencias.mediaAlbums,
          logoSlugs: [bankroll.slug],
          telegramChannelIds,
          permanente: true,
        },
      },
      select: { id: true },
    });
    return {
      slug: bankroll.slug,
      auditId: audit.id,
    };
  });
}
