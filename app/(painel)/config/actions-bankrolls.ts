import { MAX_BANKROLL_SLUG_INPUT_LENGTH } from "@/src/domain/bankroll-identity";
import type { CaptureStakePolicy } from "@/src/domain/capture-stake-policy";
import { parseDecimalInput, parseMoneyInput } from "@/src/domain/decimal-input";

import { revalidatePath } from "next/cache";
import { revalidateFinancialViews } from "../_revalidate";
import type { CapturePolicy, SharpMode } from "@/src/generated/prisma/client";
import { BankrollBetCountChangedError, criarBankroll, editarBankroll, excluirBankroll } from "@/src/services/bankrolls/manage";
import { tryDispatchBankrollLogoCleanupAudit } from "@/src/services/bankrolls/logo-cleanup";
import { deleteLogo, invalidateLogoCache, recordLogoChange, resolveLogoUrl, saveLogo } from "@/src/services/painel/logos";
import { MAX_LOGO_BYTES, prepareLogoImage } from "@/src/services/logos/storage";
import { getBankrollBySlug } from "@/src/services/painel/queries/bankrolls";
import { actor } from "../_auth";
import { RecusaDeNegocioError, refusalAsResult, type ActionResult } from "@/src/services/shared/recusa";
import { observeAction } from "@/app/_lib/observed-action";
import { getSharedBoss } from "@/src/infra/boss";
import { createLogger } from "@/src/infra/logger";
import { requeuePendingSportsOfBankroll } from "@/src/services/scheduling/enqueue-sport-resolution";
import { z } from "zod";

const log = createLogger("config-bankrolls");

const SHARP_MODES: ReadonlySet<SharpMode> = new Set(["CLV_ONLY", "IDENTITY_ONLY", "OFF"]);
const CAPTURE_POLICIES: ReadonlySet<CapturePolicy> = new Set([
  "AUTO",
  "CAPTION_ODD",
  "IMAGE_ODD",
]);

const bankrollSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_BANKROLL_SLUG_INPUT_LENGTH)
  .regex(/^[a-z0-9-]+$/);
const uuidIdSchema = z.string().uuid();
const createBankrollInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    unit: z.string().trim().min(1).max(32),
    channel: z.string().trim().max(64),
    requestId: z.uuid(),
  })
  .strict();
const editBankrollInputSchema = z
  .object({
    id: uuidIdSchema,
    name: z.string().trim().min(1).max(200),
    unit: z.string().trim().min(1).max(32),
    channel: z.string().trim().max(64),
    sharpMode: z.enum(["CLV_ONLY", "IDENTITY_ONLY", "OFF"]),
    capturePolicy: z.enum(["AUTO", "CAPTION_ODD", "IMAGE_ODD"]),
    stakePolicy: z.enum(["MESSAGE", "WHEN_MISSING", "ALWAYS"]).optional(),
    defaultStakeUnits: z.union([z.string(), z.null()]).optional(),
    channelSports: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
    capturePaused: z.boolean().optional(),
  })
  .strict();

/**
 * Cria um bankroll novo a partir do card de Bancas (capital padrão 100u, CLV_ONLY).
 * Retorna `{id, slug}` para a tela trocar o id otimista pelo id real — sem isso,
 * editar/remover a linha recém-criada (antes de recarregar) bateria num id
 * inexistente.
 */
export async function createBankrollAction(input: {
  name: string;
  unit: string;
  channel: string;
  requestId: string;
}): Promise<ActionResult<{ id: string; slug: string }>> {
  const who = await actor();
  return refusalAsResult(async () => {
    const parsed = createBankrollInputSchema.safeParse(input);
    if (!parsed.success) {
      const nameIssue = parsed.error.issues.find((issue) => issue.path[0] === "name");
      if (nameIssue) throw new RecusaDeNegocioError("Nome do tipster é obrigatório.");
      throw new RecusaDeNegocioError("Dados do tipster inválidos.");
    }
    const nome = parsed.data.name;
    const valorUnidade = parseMoneyInput(parsed.data.unit);
    if (valorUnidade == null || valorUnidade <= 0) {
      throw new RecusaDeNegocioError(`Valor da unidade inválido: ${String(parsed.data.unit)}`);
    }
    const created = await observeAction("bankroll.create", () => criarBankroll({
      nome,
      valorUnidade,
      capitalInicial: 100,
      sharpMode: "CLV_ONLY",
      // Canal novo começa decidindo pela legenda; a política específica vem depois,
      // quando o formato do tipster se revelar.
      capturePolicy: "AUTO",
      vincularContas: true,
      telegramChannelId: parsed.data.channel || null,
    }, who, { requestId: parsed.data.requestId }));
    revalidatePath("/config");
    revalidateFinancialViews();
    return { id: created.id, slug: created.slug };
  });
}

/**
 * Edita uma banca existente. O form expõe nome/unidade/canal/modo sharp e manda
 * SÓ isso: `editarBankroll` aceita patch parcial, então capital inicial, vínculo
 * de contas e bookmaker padrão ficam intactos sem a tela precisar lê-los e
 * devolvê-los. Slug é imutável (não muda no edit).
 */
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
  const who = await actor();
  return refusalAsResult(async () => {
    const parsed = editBankrollInputSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path[0];
      // Id malformado é defeito do cliente: erro, não recusa.
      if (path === "id") throw new Error("Tipster inválido.");
      if (path === "name") throw new RecusaDeNegocioError("Nome do tipster é obrigatório.");
      if (path === "sharpMode") {
        throw new RecusaDeNegocioError(`Modo sharp inválido: ${String((input as { sharpMode?: unknown }).sharpMode)}`);
      }
      if (path === "capturePolicy") {
        throw new RecusaDeNegocioError(
          `Política de captura inválida: ${String((input as { capturePolicy?: unknown }).capturePolicy)}`,
        );
      }
      throw new RecusaDeNegocioError("Dados do tipster inválidos.");
    }
    const nome = parsed.data.name;
    const valorUnidade = parseMoneyInput(parsed.data.unit);
    if (valorUnidade == null || valorUnidade <= 0) {
      throw new RecusaDeNegocioError(`Valor da unidade inválido: ${String(parsed.data.unit)}`);
    }
    if (!SHARP_MODES.has(parsed.data.sharpMode)) {
      throw new RecusaDeNegocioError(`Modo sharp inválido: ${String(parsed.data.sharpMode)}`);
    }
    if (!CAPTURE_POLICIES.has(parsed.data.capturePolicy)) {
      throw new RecusaDeNegocioError(`Política de captura inválida: ${String(parsed.data.capturePolicy)}`);
    }
    const defaultStakeUnits = parsed.data.defaultStakeUnits === undefined ? undefined
      : parsed.data.defaultStakeUnits === null || parsed.data.defaultStakeUnits.trim() === "" ? null : parseDecimalInput(parsed.data.defaultStakeUnits);
    if (parsed.data.defaultStakeUnits && defaultStakeUnits === null) throw new RecusaDeNegocioError("Stake padrão inválida.");
    const { channelSportsChanged } = await observeAction("bankroll.update", () => editarBankroll(parsed.data.id, {
      nome,
      valorUnidade,
      sharpMode: parsed.data.sharpMode,
      capturePolicy: parsed.data.capturePolicy,
      ...(parsed.data.stakePolicy !== undefined ? { stakePolicy: parsed.data.stakePolicy } : {}),
      ...(defaultStakeUnits !== undefined ? { defaultStakeUnits } : {}),
      ...(parsed.data.channelSports !== undefined ? { channelSports: parsed.data.channelSports } : {}),
      ...(parsed.data.capturePaused !== undefined ? { capturePaused: parsed.data.capturePaused } : {}),
      telegramChannelId: parsed.data.channel || null,
    }, who));
    if (channelSportsChanged) {
      // A banca já foi salva: a falha na fila só deixa as pendentes na próxima
      // tentativa agendada, que também lê a marcação nova.
      try {
        await requeuePendingSportsOfBankroll(await getSharedBoss(), parsed.data.id);
      } catch (err) {
        log.error({ err, bankrollId: parsed.data.id }, "falha ao reavaliar o esporte das apostas pendentes do canal");
      }
    }
    revalidatePath("/config");
    revalidateFinancialViews();
    return {};
  });
}

const deleteBankrollInputSchema = z.object({
  id: uuidIdSchema,
  expectedBetCount: z.number().int().min(0),
}).strict();

export type BankrollDeleteActionResult =
  | { ok: true }
  | { ok: false; erro: string; betCount: number };

/**
 * Exclui permanentemente a banca, suas apostas e os efeitos delas no ledger.
 * Recusa quando o total de apostas mudou desde a confirmação; a recusa volta
 * como resultado porque o Next esconde a mensagem de um erro lançado.
 */
export async function excluirBankrollAction(input: {
  id: string;
  expectedBetCount: number;
}): Promise<BankrollDeleteActionResult> {
  const who = await actor();
  const parsed = deleteBankrollInputSchema.safeParse(input);
  if (!parsed.success) throw new Error("Tipster inválido.");
  const { id, expectedBetCount } = parsed.data;
  let deleted: Awaited<ReturnType<typeof excluirBankroll>>;
  try {
    deleted = await observeAction("bankroll.delete", () => excluirBankroll(id, who, { expectedBetCount }));
  } catch (error) {
    if (error instanceof BankrollBetCountChangedError) {
      revalidatePath("/config");
      return { ok: false, erro: error.message, betCount: error.currentBetCount };
    }
    throw error;
  }
  if (deleted) {
    await tryDispatchBankrollLogoCleanupAudit(deleted.auditId);
    invalidateLogoCache(deleted.slug);
    revalidatePath(`/tipsters/${deleted.slug}`);
    revalidatePath(`/tipsters/${deleted.slug}/analyzer`);
  }
  revalidatePath("/config");
  revalidateFinancialViews();
  return { ok: true };
}

/**
 * Envia/troca a logo de uma banca (tipster). Recebe o `File` direto como
 * argumento da server action — sem rota POST: mutação é server action.
 * Valida o formato pelo CONTEÚDO (magic bytes — `file.type` é forjável) e
 * o tamanho; grava no diretório durável (LOGOS_DIR) e invalida o cache. Devolve a
 * URL nova p/ a tela trocar o preview na hora. O arquivo usa slug e id do
 * tipster; a troca fica na trilha com o operador, sem coluna no banco.
 */
export async function uploadLogoAction(slug: string, file: File): Promise<ActionResult<{ logoUrl: string }>> {
  const who = await actor();
  return refusalAsResult(async () => {
    const parsedSlug = bankrollSlugSchema.safeParse(slug);
    if (!parsedSlug.success) throw new Error("Tipster inválido.");
    const bankrollSlug = parsedSlug.data;
    if (!(file instanceof File) || file.size === 0) throw new RecusaDeNegocioError("Arquivo de logo ausente.");
    if (file.size > MAX_LOGO_BYTES) {
      throw new RecusaDeNegocioError(`Logo grande demais (máx ${Math.round(MAX_LOGO_BYTES / 1024 / 1024)}MB).`);
    }
    const bk = await getBankrollBySlug(bankrollSlug);
    if (!bk) throw new RecusaDeNegocioError(`Tipster "${bankrollSlug}" não encontrado.`);
    const { ext, image } = await prepareLogoImage(Buffer.from(await file.arrayBuffer()));
    await observeAction("logo.upload", () => saveLogo(bankrollSlug, ext, image, bk.id));
    const stillLive = await getBankrollBySlug(bankrollSlug);
    if (!stillLive || stillLive.id !== bk.id) {
      throw new RecusaDeNegocioError("O tipster foi removido durante o upload; a logo não foi mantida.");
    }
    await recordLogoChange({ action: "logo.upload", bankrollId: bk.id, slug: bankrollSlug, actor: who });
    revalidatePath("/config");
    revalidatePath("/tipsters");
    revalidatePath(`/tipsters/${bankrollSlug}`);
    const logoUrl = resolveLogoUrl(bankrollSlug, bk.id);
    if (!logoUrl) throw new Error("Falha ao salvar a logo."); // gravou mas não resolve → fail-loud
    return { logoUrl };
  });
}

/** Remove a logo de uma banca (volta ao monograma), com o operador na trilha. */
export async function removeLogoAction(slug: string): Promise<ActionResult> {
  const who = await actor();
  return refusalAsResult(async () => {
    const parsedSlug = bankrollSlugSchema.safeParse(slug);
    if (!parsedSlug.success) throw new Error("Tipster inválido.");
    const bankrollSlug = parsedSlug.data;
    const bk = await getBankrollBySlug(bankrollSlug);
    if (!bk) throw new RecusaDeNegocioError(`Tipster "${bankrollSlug}" não encontrado.`);
    await observeAction("logo.delete", () => deleteLogo(bankrollSlug, bk.id));
    await recordLogoChange({ action: "logo.delete", bankrollId: bk.id, slug: bankrollSlug, actor: who });
    revalidatePath("/config");
    revalidatePath("/tipsters");
    revalidatePath(`/tipsters/${bankrollSlug}`);
    return {};
  });
}
