/** Copia texto sem anunciar sucesso antes da confirmação do navegador. */
export async function copyText(text: string): Promise<void> {
  let clipboardError: unknown = null;
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      clipboardError = error;
    }
  }

  if (typeof document !== "undefined" && typeof document.execCommand === "function") {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.readOnly = true;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      if (document.execCommand("copy")) return;
    } finally {
      textarea.remove();
    }
  }

  throw clipboardError || new Error("A área de transferência não está disponível.");
}
