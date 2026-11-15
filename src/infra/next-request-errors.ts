export function isStaleServerActionError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
  return (
    message.includes("Failed to find Server Action") ||
    message.includes("Server Reference ID did not match") ||
    message.includes("failed-to-find-server-action")
  );
}

export function isBusinessRefusalError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("name" in error && error.name === "RecusaDeNegocioError") return true;
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
  return (
    message.includes("não está aberto") ||
    message.includes("já foi liquidada") ||
    message.includes("Zere o saldo") ||
    message.includes("Saque maior que o saldo")
  );
}