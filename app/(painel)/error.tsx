"use client";

import { useEffect } from "react";
import { getTheme } from "@/app/_design/theme";
import { reportBrowserError } from "@/app/_components/browser-error-reporter";

/**
 * Boundary de erro do painel — fail-loud na UI. Em vez do erro cru do Next quando
 * um Server Component/adaptador lança (ex.: consulta que estourou o tempo), mostra
 * uma prancha temada com "tentar de novo". O lado servidor já alerta nas bordas
 * (logger/alerts); aqui só damos saída visível, nunca uma tela quebrada silenciosa.
 * O botão usa `retry`, que relê o servidor: o erro veio no payload da tela, e o
 * `reset` só redesenharia o mesmo payload.
 */
export default function PainelError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("painel error boundary:", error);
    reportBrowserError("boundary", error);
  }, [error]);

  const dark =
    typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";
  const T = getTheme(dark ? "dark" : "light");

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
        <div style={{ fontSize: 17, fontWeight: 600, color: T.text, letterSpacing: "-0.01em" }}>
          Algo deu errado
        </div>
        <div style={{ fontSize: 13.5, color: T.textMuted, marginTop: 8, lineHeight: 1.5 }}>
          Não foi possível carregar esta tela. Tente de novo; se persistir, verifique o worker
          e o banco em Monitoramento.
        </div>
        <button
          onClick={() => retry()}
          style={{
            marginTop: 18,
            cursor: "pointer",
            fontFamily: T.font.body,
            fontSize: 13.5,
            fontWeight: 600,
            padding: "9px 16px",
            borderRadius: T.radiusSm,
            border: "none",
            background: T.accent,
            color: T.accentText,
          }}
        >
          Tentar de novo
        </button>
      </div>
    </div>
  );
}
