"use client";
// Contexto do design: o tema `T` e os derivados que toda tela usa (fonte de
// número, cor por sinal, troca de modo). O DesignScreen embrulha cada tela com
// o DesignProvider; componente nenhum recebe o tema por prop.
import { createContext, use, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { getTheme, type Theme, type ThemeMode } from "../theme";

export type DesignContextValue = {
  T: Theme;
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  /** Geist Mono + tabular: todo número usa isto, nunca a sans. */
  numFont: CSSProperties;
  /** Cor pelo sinal do valor: positivo, negativo ou `base` (padrão `T.text`) no zero. */
  ink: (value: number | null | undefined, base?: string) => string;
};

const DesignContext = createContext<DesignContextValue | null>(null);

/**
 * Controlado quando recebe `onMode` (o DesignScreen persiste o modo em cookie);
 * sem ele, guarda o modo sozinho, que é o que os testes de componente usam.
 */
export function DesignProvider({
  mode = "light",
  onMode,
  children,
}: {
  mode?: ThemeMode;
  onMode?: (mode: ThemeMode) => void;
  children: ReactNode;
}) {
  const [localMode, setLocalMode] = useState<ThemeMode>(mode);
  const current = onMode ? mode : localMode;
  const value = useMemo<DesignContextValue>(() => {
    const T = getTheme(current);
    return {
      T,
      mode: current,
      setMode: onMode ?? setLocalMode,
      numFont: { fontFamily: T.font.num, fontVariantNumeric: "tabular-nums", fontFeatureSettings: '"tnum" 1' },
      ink: (value, base) => (value != null && value > 0 ? T.pos : value != null && value < 0 ? T.neg : (base || T.text)),
    };
  }, [current, onMode]);
  return <DesignContext value={value}>{children}</DesignContext>;
}

export function useDesign(): DesignContextValue {
  const ctx = use(DesignContext);
  if (!ctx) throw new Error("useDesign() precisa de <DesignProvider> — o DesignScreen já provê.");
  return ctx;
}
