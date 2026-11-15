import "server-only";
import { cookies } from "next/headers";
import { THEME_COOKIE, type ThemeMode } from "@/app/_design/theme";

/** O tema do render do servidor: o que o operador escolheu, ou o claro. */
export async function themeMode(): Promise<ThemeMode> {
  return (await cookies()).get(THEME_COOKIE)?.value === "dark" ? "dark" : "light";
}
