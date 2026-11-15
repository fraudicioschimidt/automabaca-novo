import type { Metadata } from "next";
import { headers } from "next/headers";
import { themeMode } from "@/app/_lib/theme-mode";
import { NonceProvider } from "./_components/NonceProvider";
import { ServiceWorkerRegistration } from "./_components/ServiceWorkerRegistration";
import { BrowserTelemetry } from "./_components/BrowserTelemetry";
import "./fonts.css";
import "./globals.css";

// Tipografia: o design QUER Geist (a stack `"Geist", system-ui, sans-serif`); o
// "Segoe UI" que aparecia era o FALLBACK (Geist não carregava). Auto-hospedamos
// a Geist + Geist Mono (app/fonts.css → /fonts/*.woff2, latin+latin-ext) p/ ela
// carregar sempre, mesmo com CSP/ad-blocker. As telas do design usam "Geist"
// literal inline, então passam a renderizar Geist de fato.

const publicAppUrl = process.env.PUBLIC_APP_URL ?? "https://v2.fraudicio.com.br";

export const metadata: Metadata = {
  metadataBase: new URL(publicAppUrl),
  title: "AutomaBACA",
  description: "Gestão de apostas com referência sharp Pinnacle",
  robots: { index: false, follow: false, nocache: true },
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "AutomaBACA", statusBarStyle: "default" },
  alternates: { canonical: "/" },
  openGraph: {
    title: "AutomaBACA",
    description: "Gestão de apostas com referência sharp Pinnacle",
    url: "/",
    siteName: "AutomaBACA",
    type: "website",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [theme, headerStore] = await Promise.all([themeMode(), headers()]);
  const nonce = headerStore.get("x-nonce") ?? undefined;
  return (
    <html lang="pt-BR" data-theme={theme} suppressHydrationWarning>
      <body>
        <NonceProvider nonce={nonce}>
          {children}
          <ServiceWorkerRegistration />
          <BrowserTelemetry
            clientRelease={process.env.AUTOMABACA_RELEASE_ID ?? "development"}
            pageCorrelationId={headerStore.get("x-correlation-id") ?? undefined}
          />
        </NonceProvider>
      </body>
    </html>
  );
}
