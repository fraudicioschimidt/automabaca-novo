import { useState } from "react";
import type { ApostaActions } from "../../action-contracts";
import type { BetRemovalView } from "../../adapters/aposta";
import { useDesign } from "../../kit/context";
import { ICONS } from "../../kit/icons";
import { Btn } from "../../kit/primitives";
import { previousResultText, removalOriginText } from "../../lib/removal-text";
import { errorMessage, toast } from "../../toast";

/**
 * A ficha de uma aposta removida é só de leitura: diz quando e por onde ela
 * saiu e o que o estorno desfez. O "Restaurar" é o mesmo caminho do Desfazer
 * e do "Restaurar" da lista da banca; a resposta da action já traz a ficha de
 * volta à banca.
 */
export function RemovedNotice({ removal, betId, slug, onRestore }: {
  removal: BetRemovalView;
  betId: string;
  slug: string | null;
  onRestore: ApostaActions["onRestoreBets"];
}) {
  const { T } = useDesign();
  const [pending, setPending] = useState(false);
  const canRestore = Boolean(removal.restorable && slug && onRestore);
  const previous = previousResultText(removal.previous);

  const restore = async () => {
    if (!canRestore || pending) return;
    setPending(true);
    try {
      const { restored, blocked } = await onRestore!(slug!, [betId]);
      if (restored.includes(betId)) toast("Aposta de volta ao tipster", "ok");
      else if (blocked.includes(betId)) toast("A aposta não voltou: falta o estado financeiro anterior, e ela ficou para revisão em Monitoramento.", "warn");
      else toast("A aposta já tinha voltado ao tipster.", "info");
    } catch (error) {
      toast(`Não foi possível restaurar: ${errorMessage(error, "sem resposta do servidor")}`, "warn");
    } finally {
      setPending(false);
    }
  };

  return (
    <div role="status" aria-label="Aposta removida" style={{ display: 'flex', alignItems: 'center', gap: 14, rowGap: 12,
      flexWrap: 'wrap', marginBottom: 22, padding: '14px 18px', borderRadius: T.radius, background: T.negSoft,
      border: `1px solid ${T.border}`, fontFamily: T.font.body, fontSize: 13.5, lineHeight: 1.55, color: T.text }}>
      <div style={{ flex: '1 1 280px', minWidth: 0 }}>
        <b>Removida {removalOriginText(removal.origin)} em {removal.at}.</b>{' '}
        Fica fora do saldo e das métricas{previous ? `; ${previous}` : ''}.
        {removal.restorable ? null : ' Esta exclusão não guardou o estado anterior e não volta pelo painel.'}
      </div>
      {canRestore ? (
        <Btn icon={ICONS.replay} kind="primary" disabled={pending} onClick={restore}>{pending ? 'Restaurando…' : 'Restaurar'}</Btn>
      ) : null}
    </div>
  );
}
