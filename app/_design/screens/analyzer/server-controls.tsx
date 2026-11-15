import type { AnalyzerQuery } from "@/src/domain/analyzer-query";
import { useDesign } from "../../kit/context";
import { fieldStyle, FormField } from "../../kit/form";
import { Btn } from "../../kit/primitives";
import styles from "./server-controls.module.css";

type ChangeQuery = (change: Partial<AnalyzerQuery>) => void;

export function AnalyzerFilters({ query, onChange, pending = false }: {
  query: AnalyzerQuery; onChange: ChangeQuery; pending?: boolean;
}) {
  const { T } = useDesign();
  // Os campos e botões do resto do painel, com o alvo de toque de 44 px.
  const campo = { ...fieldStyle(T), minHeight: 44 };
  return <form className={styles.filters} key={`${query.esporte}:${query.casa}`} onSubmit={(event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    onChange({ esporte: String(values.get("esporte") ?? ""), casa: String(values.get("casa") ?? ""), pagina: 1 });
  }}>
    <FormField label="Esporte"><input name="esporte" maxLength={100} defaultValue={query.esporte} placeholder="Todos" style={campo} /></FormField>
    <FormField label="Casa de aposta"><input name="casa" maxLength={100} defaultValue={query.casa} placeholder="Todas" style={campo} /></FormField>
    <Btn type="submit" disabled={pending} style={{ minHeight: 44 }}>Aplicar filtros</Btn>
    {(query.esporte || query.casa) && <Btn type="button" kind="soft" disabled={pending} style={{ minHeight: 44 }} onClick={() => onChange({ esporte: "", casa: "", pagina: 1 })}>Limpar filtros</Btn>}
  </form>;
}
