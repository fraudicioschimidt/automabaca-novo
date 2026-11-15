/** Marca Refino: selo dourado sólido com linha de preço + wordmark Geist.
 * Único sobrevivente de app/_components/ após a migração ao design portado —
 * usado só pela tela de login (as 10 telas do painel usam o chrome próprio). */
export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <div
      style={{
        display: "grid",
        placeItems: "center",
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        background: "var(--brand-accent)",
        color: "var(--on-accent)",
      }}
    >
      <svg
        width={Math.round(size * 0.57)}
        height={Math.round(size * 0.57)}
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3 14l4-5 3 2 4-6 3 4" />
      </svg>
    </div>
  );
}

export function BrandWordmark() {
  return (
    <span
      data-brand-wordmark=""
      role="img"
      aria-label="AutomaBACA"
      style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.02em" }}
    >
      <span aria-hidden="true">
        Automa<b style={{ fontWeight: 600, color: "var(--brand-accent)" }}>BACA</b>
      </span>
    </span>
  );
}
