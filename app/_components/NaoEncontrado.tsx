import Link from "next/link";
import { themeMode } from "@/app/_lib/theme-mode";
import { getTheme } from "@/app/_design/theme";

/**
 * Prancha de "não encontrado" no tema do painel.
 *
 * Sem ela o Next serve a própria tela padrão — "404 · This page could not be
 * found", em inglês, fundo preto, sem marca e sem saída. Isso é alcançável no
 * uso normal: link do Telegram para uma aposta que virou 👎 (soft-delete),
 * bookmark de banca renomeada, id digitado errado.
 */
export async function NaoEncontrado({
  titulo = "Não encontramos esta página",
  descricao = "O endereço não existe ou o registro saiu da operação.",
}: {
  titulo?: string;
  descricao?: string;
}) {
  const T = getTheme(await themeMode());

  return (
    <div
      style={{
        minHeight: "70vh",
        display: "grid",
        placeItems: "center",
        background: T.bg,
        fontFamily: T.font.body,
        padding: 24,
      }}
    >
      <div
        style={{
          maxWidth: 420,
          background: T.surface,
          border: `1px solid ${T.border}`,
          borderRadius: T.radius,
          boxShadow: T.cardShadow,
          padding: 28,
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontFamily: T.font.num,
            fontSize: 30,
            fontWeight: 600,
            color: T.accent,
            letterSpacing: "-0.02em",
          }}
        >
          404
        </div>
        <div
          style={{
            fontSize: 17,
            fontWeight: 600,
            color: T.text,
            letterSpacing: "-0.01em",
            marginTop: 6,
          }}
        >
          {titulo}
        </div>
        <div style={{ fontSize: 13.5, color: T.textMuted, marginTop: 8, lineHeight: 1.5 }}>
          {descricao}
        </div>
        <Link
          href="/"
          style={{
            display: "inline-block",
            marginTop: 18,
            textDecoration: "none",
            fontFamily: T.font.body,
            fontSize: 13.5,
            fontWeight: 600,
            padding: "9px 16px",
            borderRadius: T.radiusSm,
            background: T.accent,
            color: T.accentText,
          }}
        >
          Voltar ao painel
        </Link>
      </div>
    </div>
  );
}
