/**
 * Re-monta a cada navegação → o conteúdo entra com o fade de 180ms do
 * conceito (`.page-fade` em globals; prefers-reduced-motion desliga).
 */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-fade">{children}</div>;
}
