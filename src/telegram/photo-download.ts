import type { Api } from "grammy";
import type { CaptureImage } from "@/src/domain/bet-capture";

export const MAX_TELEGRAM_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const GENERIC_BINARY_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

/** Documento com um destes tipos é tratado como foto (álbum ou OCR). */
export function isSupportedImageMime(mimeType: string): boolean {
  return ALLOWED_IMAGE_TYPES.has(mimeType);
}

function inferImageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/** Lê com limite incremental; não confia apenas em Content-Length. */
export async function telegramImageResponseToBase64(
  res: Response,
): Promise<CaptureImage> {
  try {
    if (!res.ok) throw new Error(`download da foto falhou: ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > MAX_TELEGRAM_IMAGE_BYTES) {
      throw new Error(`foto excede o limite de ${MAX_TELEGRAM_IMAGE_BYTES} bytes`);
    }
    const [rawMimeType] = (res.headers.get("content-type") ?? "").split(";", 1);
    const declaredMimeType = (rawMimeType ?? "").trim().toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.has(declaredMimeType) && !GENERIC_BINARY_TYPES.has(declaredMimeType)) {
      throw new Error(`tipo de imagem não permitido: ${declaredMimeType || "ausente"}`);
    }
    if (!res.body) throw new Error("download da foto sem corpo");

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > MAX_TELEGRAM_IMAGE_BYTES) {
          try { await reader.cancel(); } catch { /* Preserva a recusa por tamanho. */ }
          throw new Error(`foto excede o limite de ${MAX_TELEGRAM_IMAGE_BYTES} bytes`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks);
    const mimeType = ALLOWED_IMAGE_TYPES.has(declaredMimeType)
      ? declaredMimeType
      : inferImageMime(bytes);
    if (!mimeType) {
      throw new Error(`conteúdo de imagem não reconhecido: ${declaredMimeType || "tipo ausente"}`);
    }
    return { base64: bytes.toString("base64"), mimeType };
  } finally {
    try { await res.body?.cancel(); } catch { /* Stream já encerrado. */ }
  }
}

/** Baixa uma foto do Telegram por `file_id` → base64 + mime. */
export async function downloadTelegramPhoto(
  api: Api,
  token: string,
  fileId: string,
): Promise<CaptureImage> {
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error("getFile sem file_path");
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
    signal: AbortSignal.timeout(30_000),
  });
  return telegramImageResponseToBase64(res);
}
