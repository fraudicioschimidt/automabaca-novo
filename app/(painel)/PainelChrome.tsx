"use client";

import { ChromeUserContext } from "@/app/_design/chrome-context";
import { Suspense } from "react";
import { CommandPalette } from "./CommandPalette";
// A casca comum das telas (moldura, sidebar, tema, kit, toast, next/link) entra
// no chunk do layout: senão o Turbopack a repete no chunk de cada rota, e cada
// navegação no painel baixava tudo de novo.
import "@/app/_design/DesignScreen";
import "@/app/_design/AppSidebar";

/**
 * Chrome do painel: as 10 telas são o design portado e trazem a própria sidebar,
 * então o PainelChrome só provê o nome do operador (x-auth-user) para a
 * AppSidebar das telas via contexto.
 */
export function PainelChrome({
  username,
  children,
}: {
  username: string;
  children: React.ReactNode;
}) {
  return (
    <ChromeUserContext value={username}>
      {children}
      <Suspense><CommandPalette /></Suspense>
    </ChromeUserContext>
  );
}
