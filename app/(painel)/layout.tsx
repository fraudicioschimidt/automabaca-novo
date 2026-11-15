import { PainelChrome } from "./PainelChrome";
import { operadorAtual } from "./_operador";

export default async function PainelLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const username = await operadorAtual();
  return <PainelChrome username={username}>{children}</PainelChrome>;
}
