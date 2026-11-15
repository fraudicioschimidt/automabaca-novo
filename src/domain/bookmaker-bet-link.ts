/** Infer only from an actual bet/share link on an exact known bookmaker host.
 * Never fetch the URL; unrelated links and conflicting brands prove nothing. */
export function bookmakerFromBetLinks(text: string): string | null {
  const brands = new Set<string>();
  for (const raw of text.match(/https?:\/\/[^\s<>"']+/gi) ?? []) {
    let url: URL;
    try { url = new URL(raw.replace(/[),.;\]}]+$/, "")); } catch { continue; }
    if (url.username || url.password) continue;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (["bet365.bet.br", "bet365.com"].includes(host) &&
      (/^\/(?:dl\/sportsbookredirect|s\/r\/|r\/)/i.test(url.pathname) || /^#\/(?:AC|IP)\//i.test(url.hash))) brands.add("Bet365");
    if (["betano.bet.br", "betano.com"].includes(host) && /^\/bookingcode\//i.test(url.pathname)) brands.add("Betano");
    if (["kto.bet.br", "kto.com"].includes(host) && /^\/(?:esportes|sports)\//i.test(url.pathname)) brands.add("KTO");
  }
  return brands.size === 1 ? [...brands][0] ?? null : null;
}
