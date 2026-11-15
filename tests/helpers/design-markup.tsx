import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DesignProvider } from "@/app/_design/kit/context";

/** HTML estático de `ui` dentro do `DesignProvider` (tema claro), como o DesignScreen faz. */
export function renderDesignMarkup(ui: ReactElement): string {
  return renderToStaticMarkup(<DesignProvider>{ui}</DesignProvider>);
}
