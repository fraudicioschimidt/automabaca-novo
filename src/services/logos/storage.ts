import { prisma } from "@/src/infra/prisma";
import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";

/**
 * Fronteira de filesystem compartilhada pelo Next e pelo worker.
 *
 * Não importa `server-only`: o worker de produção precisa executar a limpeza
 * persistida. Os entry-points do painel continuam marcados como server-only e
 * são os únicos que expõem upload/leitura para o Next.
 */

export const LOGO_EXTENSIONS = ["jpg", "png", "webp", "jpeg"] as const;
export type LogoExt = (typeof LOGO_EXTENSIONS)[number];

const DEFAULT_LOGOS_DIR = ".logos";

export function isLogoFileMissing(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

function assertNoSymlinkComponents(directory: string): void {
  const parsed = path.parse(directory);
  let current = parsed.root;
  for (const part of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (lstatSync(/* turbopackIgnore: true */ current).isSymbolicLink()) {
        throw new Error(`LOGOS_DIR não pode atravessar symlink: ${current}`);
      }
    } catch (err) {
      if (isLogoFileMissing(err)) return;
      throw err;
    }
  }
}

export function logosDir(): string {
  const configured = process.env.LOGOS_DIR?.trim();
  if (configured && !path.isAbsolute(configured)) {
    throw new Error("LOGOS_DIR precisa ser um caminho absoluto.");
  }
  const directory = path.normalize(configured || path.join(process.cwd(), DEFAULT_LOGOS_DIR));
  const publicDir = path.join(process.cwd(), "public");
  if (directory === publicDir || directory.startsWith(`${publicDir}${path.sep}`)) {
    throw new Error("LOGOS_DIR não pode ficar dentro de public/.");
  }
  if (directory === path.parse(directory).root) {
    throw new Error("LOGOS_DIR não pode apontar para a raiz do filesystem.");
  }
  assertNoSymlinkComponents(directory);
  return directory;
}

export function logoFilePath(fileName: string): string {
  // Segunda barreira: hoje `isValidLogoFileName` já impede `..` e `/`, mas ela
  // é um regex único entre um nome vindo da URL e um `readFile`. Conferir aqui
  // faz a travessia depender de duas falhas, não de uma.
  const normalizado = path.normalize(fileName);
  if (path.isAbsolute(normalizado) || normalizado.split(path.sep).includes("..")) {
    throw new Error(`Caminho de logo fora do diretório permitido: ${fileName}`);
  }
  return path.join(
    /* turbopackIgnore: true */ logosDir(),
    /* turbopackIgnore: true */ normalizado,
  );
}

export async function unlinkLogoFileIfExists(file: string): Promise<void> {
  try {
    await unlink(/* turbopackIgnore: true */ file);
  } catch (err) {
    if (!isLogoFileMissing(err)) throw err;
  }
}

/** O id imutável separa logos de tipsters que reutilizam o mesmo slug. */
export function logoOwnerKey(slug: string, ownerId: string): string {
  return `${slug}-${ownerId}`;
}

/** Upload e limpeza compartilham a trava do slug entre web e worker. */
export async function withLogoOwnership(slug: string, ownerId: string | null, operation: () => Promise<void>): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`logo:${slug}`}, 0))`;
    // Impede a exclusão do dono durante o upload. Na limpeza sem dono,
    // qualquer upload de um tipster recriado espera a mesma trava do slug.
    const owners = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM bankrolls WHERE slug = ${slug} FOR SHARE`;
    if ((owners[0]?.id ?? null) !== ownerId) return false;
    await operation();
    return true;
  }, { timeout: 20_000 });
}

/** Remove todas as variantes da logo sem depender do runtime do Next. */
export async function deleteLogoFiles(slug: string): Promise<void> {
  for (const ext of LOGO_EXTENSIONS) {
    await unlinkLogoFileIfExists(logoFilePath(`${slug}.${ext}`));
  }
}

/** Teto de tamanho da logo recebida (logo de tipster é um ícone, não um banner). */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

// Assinaturas reais dos formatos aceitos: o tipo declarado é forjável; o
// conteúdo é a única prova.
const MAGIC: Array<{ ext: LogoExt; check: (b: Buffer) => boolean }> = [
  { ext: "jpg", check: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "png", check: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  {
    ext: "webp",
    check: (b) =>
      b.length > 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP",
  },
];

/** Detecta o formato pelo conteúdo; null = não é JPG/PNG/WebP de verdade. */
export function sniffLogoExt(buffer: Buffer): LogoExt | null {
  return MAGIC.find((m) => m.check(buffer))?.ext ?? null;
}

/** Decodifica e reencoda a imagem: bytes extras/poliglotas nunca chegam ao disco. */
async function normalizeLogoImage(buffer: Buffer, ext: LogoExt): Promise<Buffer> {
  try {
    const image = sharp(buffer, {
      animated: false,
      failOn: "error",
      limitInputPixels: 4096 * 4096,
    })
      .rotate()
      .resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true });
    if (ext === "png") return await image.png({ compressionLevel: 9 }).toBuffer();
    if (ext === "webp") return await image.webp({ quality: 90 }).toBuffer();
    return await image.jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  } catch {
    throw new RecusaDeNegocioError("Imagem inválida ou corrompida.");
  }
}

/**
 * Validação única de logo (upload do painel e foto do canal): tamanho, formato
 * real e reencode. O que ela recusa é o arquivo que o operador escolheu:
 * recusa de negócio, com a mensagem até a tela.
 */
export async function prepareLogoImage(buffer: Buffer): Promise<{ ext: LogoExt; image: Buffer }> {
  if (buffer.length === 0) throw new RecusaDeNegocioError("Arquivo de logo ausente.");
  if (buffer.length > MAX_LOGO_BYTES) {
    throw new RecusaDeNegocioError(`Logo grande demais (máx ${Math.round(MAX_LOGO_BYTES / 1024 / 1024)}MB).`);
  }
  const ext = sniffLogoExt(buffer);
  if (!ext) throw new RecusaDeNegocioError("Formato inválido — envie JPG, PNG ou WebP.");
  return { ext, image: await normalizeLogoImage(buffer, ext) };
}

/**
 * Grava a logo do dono (remove variantes em outras extensões — trocar png→jpg
 * deixaria as duas e a leitura pegaria a errada).
 */
export async function writeLogoFile(slug: string, ext: LogoExt, buffer: Buffer, ownerId: string): Promise<void> {
  const key = logoOwnerKey(slug, ownerId);
  const saved = await withLogoOwnership(slug, ownerId, async () => {
    await mkdir(/* turbopackIgnore: true */ logosDir(), { recursive: true, mode: 0o700 });
    const target = logoFilePath(`${key}.${ext}`);
    const temporary = logoFilePath(`.${key}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(/* turbopackIgnore: true */ temporary, buffer, { mode: 0o600 });
      await rename(/* turbopackIgnore: true */ temporary, target);
    } catch (err) {
      await unlinkLogoFileIfExists(temporary);
      throw err;
    }
    for (const old of LOGO_EXTENSIONS) {
      if (old === ext) continue;
      await unlinkLogoFileIfExists(logoFilePath(`${key}.${old}`));
    }
  });
  if (!saved) throw new RecusaDeNegocioError("O tipster mudou ou foi removido durante o upload; tente novamente.");
}
