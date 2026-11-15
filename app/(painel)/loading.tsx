import { themeMode } from "@/app/_lib/theme-mode";
import { getTheme } from "@/app/_design/theme";

/**
 * Estado de navegação do painel — placeholder temado (sem flash branco) enquanto o
 * Server Component da rota busca o dado. Lê o modo do cookie (mesma fonte do app).
 */
export default async function PainelLoading() {
  const mode = await themeMode();
  const T = getTheme(mode);
  return (
    <div style={{ minHeight: "70vh", display: "grid", placeItems: "center", background: T.bg }}>
      <div style={{ fontFamily: T.font.body, fontSize: 13.5, color: T.textFaint }}>Carregando…</div>
    </div>
  );
}
