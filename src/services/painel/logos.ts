import { RecusaDeNegocioError } from "@/src/services/shared/recusa";
import "server-only";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import {
  deleteLogoFiles,
  isLogoFileMissing,
  LOGO_EXTENSIONS,
  logoFilePath,
  logoOwnerKey,
  type LogoExt,
  writeLogoFile,
  withLogoOwnership,
} from "@/src/services/logos/storage";
import { prisma } from "@/src/infra/prisma";


/**
 * Logos de tipster, em armazenamento durável fora do bundle: com o web rodando
 * em .next/standalone, gravar em `cwd/public` escreveria dentro do bundle e o
 * upload morreria no deploy seguinte. `LOGOS_DIR` aponta para o volume
 * `/data/logos` em produção; default = .logos do cwd (dev), sempre fora de public.
 * Servidas por /api/logos/[file] com uma versão opaca para furar cache ao trocar.
 */

const LOGO_CACHE_TTL_MS = 60_000;
const LOGO_CACHE_MAX_ENTRIES = 500;
const logoCache = new Map<string, { url: string | null; expiresAt: number; ownerId: string }>();

/** URL da logo por slug (ou null). Cacheado por processo; invalidar no upload. */
export function resolveLogoUrl(slug: string, ownerId: string): string | null {
  const cached = logoCache.get(slug);
  if (cached && cached.ownerId === ownerId && cached.expiresAt > Date.now()) {
    logoCache.delete(slug);
    logoCache.set(slug, cached);
    return cached.url;
  }
  let url: string | null = null;
  for (const key of [logoOwnerKey(slug, ownerId), slug]) {
    for (const ext of LOGO_EXTENSIONS) {
      const file = logoFilePath(`${key}.${ext}`);
      try {
        const stat = lstatSync(/* turbopackIgnore: true */ file);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const version = createHash("sha256")
          .update(`${stat.size}:${Math.floor(stat.mtimeMs)}`)
          .digest("hex")
          .slice(0, 12);
        url = `/api/logos/${key}.${ext}?v=${version}`;
        break;
      } catch (err) {
        if (!isLogoFileMissing(err)) throw err;
      }
    }
    if (url) break;
  }
  logoCache.delete(slug);
  if (logoCache.size >= LOGO_CACHE_MAX_ENTRIES) {
    const oldest = logoCache.keys().next().value;
    if (oldest !== undefined) logoCache.delete(oldest);
  }
  logoCache.set(slug, { url, expiresAt: Date.now() + LOGO_CACHE_TTL_MS, ownerId });
  return url;
}

export function invalidateLogoCache(slug: string): void {
  logoCache.delete(slug);
}

/** Grava a logo do slug e invalida o cache deste processo. */
export async function saveLogo(slug: string, ext: LogoExt, buffer: Buffer, ownerId: string): Promise<void> {
  await writeLogoFile(slug, ext, buffer, ownerId);
  invalidateLogoCache(slug);
}

/** Remove a logo do slug (todas as variantes de extensão) e invalida o cache. */
export async function deleteLogo(slug: string, ownerId: string): Promise<void> {
  if (!await withLogoOwnership(slug, ownerId, async () => {
    await deleteLogoFiles(logoOwnerKey(slug, ownerId));
    await deleteLogoFiles(slug);
  })) {
    throw new RecusaDeNegocioError("O tipster mudou ou foi removido; recarregue a página.");
  }
  invalidateLogoCache(slug);
}

/**
 * A logo não tem coluna no banco: a troca pelo painel fica na trilha, com o
 * operador que a fez, como as outras mudanças da banca.
 */
export async function recordLogoChange(params: {
  action: "logo.upload" | "logo.delete";
  bankrollId: string;
  slug: string;
  actor: string;
}): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      actor: params.actor,
      action: params.action,
      resource: "bankroll",
      resourceId: params.bankrollId,
      details: { slug: params.slug },
    },
  });
}

/** Lê uma logo pelo nome de arquivo JÁ validado (slug.ext). */
export async function readLogo(fileName: string): Promise<Buffer | null> {
  const file = logoFilePath(fileName);
  try {
    const stat = await lstat(/* turbopackIgnore: true */ file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return await readFile(/* turbopackIgnore: true */ file);
  } catch (err) {
    if (isLogoFileMissing(err)) return null;
    throw err;
  }
}

/** Valida o nome de arquivo de logo (anti path-traversal). */
export function isValidLogoFileName(name: string): name is `${string}.${LogoExt}` {
  return /^[a-z0-9-]+\.(jpg|jpeg|png|webp)$/.test(name);
}

export const LOGO_CONTENT_TYPES: Record<LogoExt, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
