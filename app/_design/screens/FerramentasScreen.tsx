"use client";
// Ferramentas: calculadora Kelly.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useDesign } from "../kit/context";
import { AppSidebar } from "../AppSidebar";
import { AppShell } from "../kit/primitives";
import { fieldStyle, FormField } from "../kit/form";
import { Icon, ICONS } from "../kit/icons";
import type { FerramentasScreenProps } from "../screen-types";
import { KellyPanel, type CamposKelly } from "./ferramentas/kelly-panel";
import { KELLY_DEFAULT_CAP_UNITS, KELLY_DEFAULT_FRACTION } from "@/src/domain/kelly";

export function FerramentasScreen({ data }: FerramentasScreenProps) {
  const { T } = useDesign();
  const router = useRouter();

  // A calculadora abre com a fração e o teto padrão; os campos são livres.
  const [k, setK] = useState<CamposKelly>({
    odd: '1.90', vantagem: '5', frac: String(KELLY_DEFAULT_FRACTION), bank: '100', cap: String(KELLY_DEFAULT_CAP_UNITS),
  });
  const kf = (key: keyof CamposKelly, v: string) => setK((s) => ({ ...s, [key]: v }));
  const bankrolls = (data && data.bankrolls) || [];
  const selectedBankrollId = data && data.selectedBankrollId;
  const selectedNome = data && data.selectedBankrollNome;
  const Sidebar = <AppSidebar active="Ferramentas" />;

  return (
    <AppShell sidebar={Sidebar}>
      <div className="app-main" style={{ flex: 1, minWidth: 0, padding: '46px', maxWidth: 1180, margin: '0 auto' }}>
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ margin: 0, fontFamily: T.font.display, fontSize: 32, fontWeight: T.displayWeight, letterSpacing: T.displaySpacing, color: T.text, lineHeight: 1.05 }}>Ferramentas</h1>
          <div style={{ fontFamily: T.font.body, fontSize: 14, color: T.textMuted, marginTop: 6 }}>Dimensione stake com Kelly a partir da vantagem estimada{selectedNome ? ` · ${selectedNome}` : ''}.</div>
          {bankrolls.length > 1 ? (
            <div style={{ width: 280, maxWidth: '100%', marginTop: 16 }}>
              <FormField label="Canal">
                <span style={{ position: 'relative', display: 'block' }}>
                  <select
                    value={selectedBankrollId || ''}
                    onChange={(e) => {
                      // Navegação do App Router: troca só o dado do canal e mantém os
                      // campos do Kelly digitados, que um recarregamento zeraria.
                      const url = new URL(window.location.href);
                      if (e.target.value) url.searchParams.set('bankroll', e.target.value);
                      else url.searchParams.delete('bankroll');
                      router.replace(url.pathname + url.search, { scroll: false });
                    }}
                    style={{ ...fieldStyle(T), minHeight: 44, appearance: 'none', cursor: 'pointer', paddingRight: 34 }}
                  >
                    {bankrolls.map((b) => (
                      <option key={b.id} value={b.id}>{b.nome}</option>
                    ))}
                  </select>
                  <span aria-hidden="true" style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: T.textFaint, display: 'flex' }}><Icon d={ICONS.chevronDownWide} s={14} /></span>
                </span>
              </FormField>
            </div>
          ) : null}
        </div>
        <KellyPanel k={k} kf={kf} clvCanal={(data && data.clvCanal) || null} />
        <div style={{ height: 20 }} />
      </div>
    </AppShell>
  );
}
