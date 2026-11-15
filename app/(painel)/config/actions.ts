"use server";

import { revalidatePath } from "next/cache";
import { adicionarMercadoAlias, removerMercadoAlias } from "@/src/services/mercados/aliases";
import { listTeamCards, removeTeamTipsterName } from "@/src/services/painel/team-cards";
import { getConfigPageData } from "@/src/services/painel/config";
import { getConfigCatalogPairing } from "@/app/_design/adapters/config";
import { requestCatalogPairingRound } from "@/src/services/painel/catalog-pairing";
import { actor, requireSession, currentSessionId } from "../_auth";
import { observeAction } from "@/app/_lib/observed-action";
import { RecusaDeNegocioError, refusalAsResult, type ActionResult } from "@/src/services/shared/recusa";
import { revokeDeviceSession, revokeOtherDeviceSessions } from "@/src/services/auth/device-sessions";
import { z } from "zod";
import type { CaptureStakePolicy } from "@/src/domain/capture-stake-policy";
import type { CapturePolicy, SharpMode } from "@/src/generated/prisma/client";
import {
  createBankrollAction as runCreateBankroll,
  editarBankrollAction as runEditarBankroll,
  excluirBankrollAction as runExcluirBankroll,
  uploadLogoAction as runUploadLogo,
  removeLogoAction as runRemoveLogo,
} from "./actions-bankrolls";

const uuidIdSchema = z.string().uuid();

const teamCardsQuerySchema = z.object({
  query: z.string().max(100).optional(),
  sport: z.string().max(40).nullable().optional(),
  offset: z.number().int().min(0).max(1_000_000).optional(),
}).strict();

/** Uma página das fichas de time, com a busca e o filtro de esporte da tela. */
export async function loadTeamCardsAction(input: z.input<typeof teamCardsQuerySchema> = {}) {
  await requireSession();
  const parsed = teamCardsQuerySchema.safeParse(input);
  if (!parsed.success) throw new Error("Busca de times inválida.");
  return listTeamCards(parsed.data);
}

/** A linha de situação do pareamento, relida enquanto a rodada pedida roda. */
export async function loadCatalogPairingAction() {
  await requireSession();
  return getConfigCatalogPairing();
}

/**
 * "Buscar jogos agora": enfileira uma rodada do pareamento dos catálogos para
 * o worker, que tem as chaves dos fornecedores. Com uma rodada já na fila ou
 * rodando, não cria outra e diz isso.
 */
export async function requestCatalogPairingAction(): Promise<ActionResult<{ status: "enfileirado" | "ja_na_fila" }>> {
  const who = await actor();
  return refusalAsResult(async () => {
    const status = await observeAction("teams.catalog_pairing.request", () => requestCatalogPairingRound(who));
    return { status };
  });
}

// As mutações da Config devolvem a recusa como resultado (`refusalAsResult`):
// o Next esconde a mensagem de erro lançado em produção. A sessão continua
// guardada por `actor()`, antes de qualquer leitura.

/** Tira um nome de tipster da ficha do time (só a linha do nome). */
export async function removeTipsterNameAction(id: string): Promise<ActionResult> {
  const who = await actor();
  return refusalAsResult(async () => {
    const parsed = uuidIdSchema.safeParse(id);
    // Id malformado é defeito do cliente e segue como erro.
    if (!parsed.success) throw new Error("Nome de tipster inválido.");
    // Sem revalidar a rota: a lista de fichas (com a busca e as páginas já
    // abertas) é da tela, que tira o nome dela.
    await observeAction("team_tipster_name.delete", () => removeTeamTipsterName(parsed.data, who));
    return {};
  });
}

/** Bancas / logos — wrappers "use server" sobre helpers sem diretiva. */
export async function createBankrollAction(input: {
  name: string;
  unit: string;
  channel: string;
  requestId: string;
}): Promise<ActionResult<{ id: string; slug: string }>> {
  return runCreateBankroll(input);
}

export async function editarBankrollAction(input: {
  id: string;
  name: string;
  unit: string;
  channel: string;
  sharpMode: SharpMode;
  capturePolicy: CapturePolicy;
  stakePolicy?: CaptureStakePolicy;
  defaultStakeUnits?: string | null;
  channelSports?: string[];
  capturePaused?: boolean;
}): Promise<ActionResult> {
  return runEditarBankroll(input);
}

export async function excluirBankrollAction(input: { id: string; expectedBetCount: number }) {
  return runExcluirBankroll(input);
}

export async function uploadLogoAction(slug: string, file: File): Promise<ActionResult<{ logoUrl: string }>> {
  return runUploadLogo(slug, file);
}

export async function removeLogoAction(slug: string): Promise<ActionResult> {
  return runRemoveLogo(slug);
}

// O alias é texto de tipster (nome de mercado); o teto só barra lixo grande.
const marketAliasInputSchema = z.object({
  canon: z.string().trim().min(1).max(120),
  alias: z.string().trim().min(1).max(200),
}).strict();

function parseMarketAliasInput(canon: unknown, alias: unknown): z.infer<typeof marketAliasInputSchema> {
  const parsed = marketAliasInputSchema.safeParse({ canon, alias });
  if (!parsed.success) throw new RecusaDeNegocioError("Alias de mercado inválido (texto de 1 a 200 caracteres).");
  return parsed.data;
}

/** Adiciona um alias a um mercado canônico (resolve o id do mercado pelo nome). */
export async function addMarketAliasAction(canon: string, alias: string): Promise<ActionResult> {
  const who = await actor();
  return refusalAsResult(async () => {
    const input = parseMarketAliasInput(canon, alias);
    const { mercados } = await getConfigPageData();
    const mercado = mercados.find((m) => m.nome === input.canon);
    if (!mercado) throw new RecusaDeNegocioError(`Mercado "${input.canon}" não encontrado.`);
    await observeAction("market_alias.create", () =>
      adicionarMercadoAlias({ mercadoPadraoId: mercado.id, alias: input.alias, actor: who }),
    );
    revalidatePath("/config");
    return {};
  });
}

/** Remove um alias de mercado (resolve o id do alias pelo texto + mercado). */
export async function removeMarketAliasAction(canon: string, alias: string): Promise<ActionResult> {
  const who = await actor();
  return refusalAsResult(async () => {
    const input = parseMarketAliasInput(canon, alias);
    const { mercados } = await getConfigPageData();
    const mercado = mercados.find((m) => m.nome === input.canon);
    const row = mercado?.aliases.find((a) => a.alias === input.alias);
    if (!row) throw new RecusaDeNegocioError(`Alias "${input.alias}" não encontrado em "${input.canon}".`);
    await observeAction("market_alias.delete", () => removerMercadoAlias(row.id, who));
    revalidatePath("/config");
    return {};
  });
}

export async function revokeSessionAction(sessionId: string): Promise<ActionResult> {
  const who = await actor();
  return refusalAsResult(async () => {
    const parsedSessionId = uuidIdSchema.safeParse(sessionId);
    if (!parsedSessionId.success) throw new Error("Sessão inválida.");
    await observeAction("auth.session_revoke", () => revokeDeviceSession(who, parsedSessionId.data, who));
    revalidatePath("/config");
    return {};
  });
}

export async function revokeOtherSessionsAction(): Promise<ActionResult<{ count: number }>> {
  const who = await actor();
  return refusalAsResult(async () => {
    const currentId = await currentSessionId();
    if (!currentId) throw new RecusaDeNegocioError("Sessão atual inválida — faça login novamente.");
    const count = await observeAction("auth.sessions_revoke_others", () =>
      revokeOtherDeviceSessions(who, currentId, who),
    );
    revalidatePath("/config");
    return { count };
  });
}
