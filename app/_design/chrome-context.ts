import { createContext } from "react";

/**
 * Nome do operador logado (x-auth-user), provido pelo PainelChrome e lido pela
 * AppSidebar das telas do design — evita prop-drill pelas 10 telas do painel.
 */
export const ChromeUserContext = createContext<string | null>(null);
