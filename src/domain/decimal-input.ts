/** Converte entrada decimal do painel aceitando separador brasileiro ou internacional. */
export function parseDecimalInput(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const rawTrimmed = value.trim();
  if (!rawTrimmed) return null;
  if (/\s/.test(rawTrimmed)) return null;
  if (/[.,]$/.test(rawTrimmed)) return null;

  const compact = rawTrimmed;

  const unsigned = compact.replace(/^[+-]/, "");
  const sign = compact.startsWith("-") ? "-" : compact.startsWith("+") ? "+" : "";
  const commaCount = (unsigned.match(/,/g) ?? []).length;
  const dotCount = (unsigned.match(/\./g) ?? []).length;
  let normalized = compact;
  if (commaCount > 0 && dotCount > 0) {
    const decimalSeparator = unsigned.lastIndexOf(",") > unsigned.lastIndexOf(".") ? "," : ".";
    const groupingSeparator = decimalSeparator === "," ? "." : ",";
    const [integerPart, decimalPart, ...extra] = unsigned.split(decimalSeparator);
    const groupedPattern = new RegExp(`^\\d{1,3}(?:\\${groupingSeparator}\\d{3})+$`);
    if (extra.length > 0 || !integerPart || !decimalPart || !/^\d+$/.test(decimalPart)) return null;
    if (integerPart.includes(groupingSeparator)) {
      const firstGroup = integerPart.split(groupingSeparator)[0];
      if (!firstGroup || firstGroup === "0" || /^0\d/.test(firstGroup) || !groupedPattern.test(integerPart)) {
        return null;
      }
    } else if (!/^\d+$/.test(integerPart) || /^0\d/.test(integerPart)) return null;
    normalized = `${sign}${integerPart.replaceAll(groupingSeparator, "")}.${decimalPart}`;
  } else {
    const separator = commaCount > 0 ? "," : dotCount > 0 ? "." : null;
    const count = separator === "," ? commaCount : dotCount;
    if (separator && count > 1) {
      const groupingPattern = new RegExp(`^\\d{1,3}(?:\\${separator}\\d{3})+$`);
      if (!groupingPattern.test(unsigned)) return null;
      const firstGroup = unsigned.split(separator)[0];
      if (!firstGroup || firstGroup === "0" || /^0\d/.test(firstGroup)) return null;
      normalized = `${sign}${unsigned.replaceAll(separator, "")}`;
    } else if (separator === ",") {
      const parts = unsigned.split(",");
      if (parts[0] && /^0\d/.test(parts[0])) return null;
      normalized = compact.replace(",", ".");
    } else if (separator === ".") {
      const parts = unsigned.split(".");
      if (parts[0] && /^0\d/.test(parts[0])) return null;
      normalized = compact;
    } else {
      if (/^0\d/.test(unsigned)) return null;
    }
  }

  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Converte valor monetário digitado em reais.
 *
 * Um único ponto com três casas é ambíguo no parser genérico: `1.000` pode ser
 * odd/stake 1.000 ou R$ 1.000. Nos campos explicitamente rotulados em R$, a
 * convenção brasileira vence; nos demais, `parseDecimalInput` continua tratando
 * o ponto como separador decimal.
 */
export function parseMoneyInput(value: unknown): number | null {
  if (typeof value !== "string") return parseDecimalInput(value);
  const trimmed = value.trim();
  // Espaço só separa grupos completos de milhares; nunca cola dígitos de
  // entradas quebradas, como "1 2" ou uma quebra de linha na parte decimal.
  if (/\s/.test(trimmed) && !/^[+-]?[1-9]\d{0,2}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?$/.test(trimmed)) return null;
  const compact = trimmed.replace(/[ \u00a0\u202f]/g, "");
  const brThousands = compact.match(/^([+-]?)([1-9]\d{0,2})\.(\d{3})$/);
  if (brThousands) {
    return parseDecimalInput(`${brThousands[1] ?? ""}${brThousands[2] ?? ""}${brThousands[3] ?? ""}`);
  }
  return parseDecimalInput(compact);
}
