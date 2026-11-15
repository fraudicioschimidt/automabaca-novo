import { isIP } from "node:net";

export type BodyReadFailure = { ok: false; reason: "invalid" | "too_large" };
export type BodyReadResult<T> = { ok: true; value: T } | BodyReadFailure;

type BodyReadOptions = {
  /** Corta o upload lento: estourado o prazo, o corpo conta como inválido. */
  timeoutMs?: number;
};

/** Lê o stream com teto real; não confia apenas no Content-Length declarado. */
export async function readTextBodyWithin(
  request: Request,
  maxBytes: number,
  options: BodyReadOptions = {},
): Promise<BodyReadResult<string>> {
  const declaredHeader = request.headers.get("content-length");
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader);
    if (!Number.isFinite(declared) || declared < 0) return { ok: false, reason: "invalid" };
    if (declared > maxBytes) return { ok: false, reason: "too_large" };
  }

  if (!request.body) return { ok: true, value: "" };
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  let timedOut = false;
  const timeout = options.timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
      timedOut = true;
      reader.cancel().catch(() => {});
    }, options.timeoutMs);
  timeout?.unref?.();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        if (timedOut) return { ok: false, reason: "invalid" };
        break;
      }
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("payload excedeu o limite");
        return { ok: false, reason: "too_large" };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, value: text };
  } catch {
    return { ok: false, reason: "invalid" };
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

export async function readJsonBodyWithin(
  request: Request,
  maxBytes: number,
  options: BodyReadOptions = {},
): Promise<BodyReadResult<unknown>> {
  const body = await readTextBodyWithin(request, maxBytes, options);
  if (!body.ok) return body;
  try {
    return { ok: true, value: JSON.parse(body.value) as unknown };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

/** Último XFF escrito pelo proxy imediato; ignora X-Real-IP e prefixos do cliente. */
export function clientIpFromHeaders(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (!forwarded) return "";
  const ip = forwarded.slice(forwarded.lastIndexOf(",") + 1).trim();
  return isIP(ip) ? ip : "";
}

/**
 * Rejeita POSTs iniciados por outra origem sem depender apenas de SameSite.
 * Browsers modernos informam Origin ou Sec-Fetch-Site. Sem ambos, a origem não
 * pode ser provada e a operação mutável falha fechada.
 */
export function hasTrustedRequestOrigin(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite === "cross-site") return false;

  const origin = request.headers.get("origin");
  if (!origin) return fetchSite === "same-origin" || fetchSite === "same-site";

  try {
    const received = new URL(origin);
    const requestUrl = new URL(request.url);
    // Na borda Caddy, Host é preservado e X-Forwarded-Proto é reescrito.
    // Compara com o host efetivo da requisição, sem depender de X-Forwarded-Host.
    const host = (request.headers.get("host") || requestUrl.host).toLowerCase();
    const forwardedProto = request.headers.get("x-forwarded-proto")
      ?.split(",")[0]
      ?.trim();
    const protocol = `${forwardedProto || requestUrl.protocol.replace(":", "")}:`.toLowerCase();
    return received.host.toLowerCase() === host && received.protocol.toLowerCase() === protocol;
  } catch {
    return false;
  }
}

/** Teto único de corpos JSON externos, incluindo catálogos e OCR. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`corpo da resposta acima de ${Math.round(limit / 1024 / 1024)}MB`);
    this.name = "BodyTooLargeError";
  }
}
/**
 * `res.json()` bufferiza o corpo inteiro sem teto: um endpoint mal-comportado
 * (ou um `sport_id` invertido) derruba o worker por memória. Lê com teto.
 */
export async function readJsonCapped<T>(res: Response): Promise<T> {
  try {
    const declarado = Number(res.headers?.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declarado) && declarado > MAX_BODY_BYTES) {
      throw new BodyTooLargeError(MAX_BODY_BYTES);
    }
    const reader = res.body?.getReader();
    if (!reader) {
      if (typeof res.arrayBuffer === "function") {
        const buf = await res.arrayBuffer();
        if (buf.byteLength > MAX_BODY_BYTES) {
          throw new BodyTooLargeError(MAX_BODY_BYTES);
        }
        return JSON.parse(new TextDecoder().decode(buf)) as T;
      }
      if (typeof res.text === "function") {
        const text = await res.text();
        const bytes = new TextEncoder().encode(text).byteLength;
        if (bytes > MAX_BODY_BYTES) {
          throw new BodyTooLargeError(MAX_BODY_BYTES);
        }
        return JSON.parse(text) as T;
      }
      if (typeof res.json === "function") {
        return (await res.json()) as T;
      }
      throw new BodyTooLargeError(MAX_BODY_BYTES);
    }
    const partes: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // O corpo já será descartado; falha ao cancelar não muda o erro de tamanho.
          }
          throw new BodyTooLargeError(MAX_BODY_BYTES);
        }
        partes.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(new TextDecoder().decode(Buffer.concat(partes, total))) as T;
  } finally {
    // Inclui recusa pelo tamanho declarado antes de adquirir o reader.
    try { await res.body?.cancel?.(); } catch { /* Stream já encerrado. */ }
  }
}
