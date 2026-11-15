import { createHash } from "node:crypto";

/**
 * JSON determinístico para chaves de idempotência e hashes de conteúdo.
 * Aceita somente o domínio JSON real: coerções de BigInt/Date/undefined para
 * string/null tornariam a representação não-injetiva e poderiam deduplicar
 * trabalhos semanticamente diferentes.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    throw new TypeError("canonicalJson: undefined não pertence ao domínio JSON.");
  }
  if (typeof value === "bigint") {
    throw new TypeError("canonicalJson: BigInt não pertence ao domínio JSON.");
  }
  if (typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`canonicalJson: tipo não suportado (${typeof value}).`);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError(`canonicalJson: número não-finito (${String(value)}).`);
  }
  if (value instanceof Date) {
    throw new TypeError("canonicalJson: Date deve ser convertido explicitamente para ISO string.");
  }
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError(`canonicalJson: valor não serializável (${typeof value}).`);
    }
    return serialized;
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError(`canonicalJson: posição ausente no array (${index}).`);
      }
      items.push(canonicalJson(value[index]));
    }
    return `[${items.join(",")}]`;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(
      `canonicalJson: tipo estruturado não suportado (${value.constructor?.name ?? "desconhecido"}).`,
    );
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`;
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
