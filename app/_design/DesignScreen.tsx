"use client";

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { DesignProvider } from "./kit/context";
import { getTheme, THEME_COOKIE, type ThemeMode as Mode } from "./theme";
import { ensureToast } from "./toast";
import { useNonce } from "@/app/_components/NonceProvider";

/**
 * Moldura comum das telas: tema (cookie + `data-theme`, provido pelo
 * `DesignProvider`) e toast. A tela vem como filho, então a página do servidor
 * a monta direto quando não há o que embrulhar no cliente. A largura não passa
 * por aqui: cada tela resolve o próprio layout por CSS (`kit/faixas`), e a
 * navegação interna é `next/link`.
 */
export function DesignScreen({ initialMode, children }: { initialMode: Mode; children: ReactNode }) {
  const nonce = useNonce();
  const [mode, setMode] = useState<Mode>(initialMode);

  useEffect(() => {
    ensureToast(nonce);
  }, [nonce]);

  useEffect(() => {
    document.body.style.background = getTheme(mode).bg;
  }, [mode]);

  const onMode = useCallback((mm: Mode) => {
    setMode(mm);
    document.documentElement.dataset.theme = mm;
    const secure = window.location.protocol === "https:" ? ";secure" : "";
    document.cookie = `${THEME_COOKIE}=${mm};path=/;max-age=31536000;samesite=lax${secure}`;
  }, []);

  // As telas foram desenhadas sobre os padrões do navegador; o line-height e o
  // font-size globais do body esticariam o texto dos estilos inline.
  const reset: CSSProperties = { lineHeight: "normal", fontSize: 16, textRendering: "auto" };
  return (
    <div className="design-reset" style={reset}>
      <DesignProvider mode={mode} onMode={onMode}>
        {children}
      </DesignProvider>
    </div>
  );
}
