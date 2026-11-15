"use client";
import type { CSSProperties, ReactNode } from "react";
import { DEFINICOES, type DefinicaoDeMetrica } from "../lib/definicoes-de-metrica";
import { Tooltip } from "./Tooltip";

/**
 * Rótulo de métrica que carrega a própria definição (fonte única em
 * `lib/definicoes-de-metrica`). Sem chave, ou com chave inexistente, renderiza
 * o rótulo cru: a tela nunca some por causa de texto de apoio.
 */
export function MetricaComDefinicao({
  metrica,
  children,
  style,
  bloco = true,
}: {
  metrica?: string;
  children?: ReactNode;
  style?: CSSProperties;
  bloco?: boolean;
}) {
  const def: DefinicaoDeMetrica | undefined = metrica ? (DEFINICOES as Record<string, DefinicaoDeMetrica>)[metrica] : undefined;
  if (!def) return <>{children}</>;
  return (
    <Tooltip titulo={def.titulo} texto={def.texto} formula={def.formula} style={style} bloco={bloco}>
      {children ?? def.titulo}
    </Tooltip>
  );
}
