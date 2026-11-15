import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AutomaBACA",
    short_name: "AutomaBACA",
    description: "Gestão operacional de apostas e referência sharp.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    // Mesmo `--canvas` do tema Refino (app/globals.css, app/_design/theme.ts):
    // a splash do PWA instalado não pode abrir num tom que a tela não usa.
    background_color: "#f6f5f2",
    theme_color: "#a9803c",
    orientation: "any",
    categories: ["business", "finance", "productivity"],
    icons: [
      { src: "/pwa-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/pwa-icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
