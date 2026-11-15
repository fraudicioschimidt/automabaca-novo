import { useState } from "react";
import {
  betExportFilename,
  buildBetExportCsv,
  buildBetExportTsv,
  uiBetToExportInput,
} from "@/src/domain/bet-export";
import type { BankrollActions } from "../../action-contracts";
import { copyText } from "../../lib/clipboard";
import { contagem, plural } from "../../lib/plural";
import { errorMessage, toast } from "../../toast";

type ExportableBet = Parameters<typeof uiBetToExportInput>[0];

function downloadCsvBlob(csv: string, filename: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(anchor.href);
}

/**
 * CSV completo pelo servidor quando há banca real; sem ele, só as apostas
 * carregadas. "Copiar apostas filtradas" leva o recorte filtrado em TSV.
 */
export function useBetExport({ slug, allBets, filtered, onExportCsv }: {
  slug: string | undefined;
  allBets: readonly ExportableBet[];
  filtered: readonly ExportableBet[];
  onExportCsv: BankrollActions["onExportCsv"];
}) {
  const [exporting, setExporting] = useState(false);

  const exportCSV = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      if (onExportCsv && slug) {
        const { csv, count, filename } = await onExportCsv(slug);
        downloadCsvBlob(csv, filename);
        toast(`${contagem(count, 'aposta')} ${plural(count, 'exportada')} (CSV completo)`, "ok");
        return;
      }
      const rows = allBets.map(uiBetToExportInput);
      downloadCsvBlob(buildBetExportCsv(rows), betExportFilename(slug));
      toast(`${contagem(rows.length, 'aposta')} ${plural(rows.length, 'exportada')} (CSV)`, "ok");
    } catch (err) {
      toast(errorMessage(err, "Falha ao exportar CSV"), "warn");
    } finally {
      setExporting(false);
    }
  };

  const copyVisible = async () => {
    const rows = filtered.map(uiBetToExportInput);
    try {
      await copyText(buildBetExportTsv(rows));
      toast(`${contagem(rows.length, 'aposta')} ${plural(rows.length, 'copiada')}`, "ok");
    } catch {
      toast("Não foi possível copiar as apostas", "warn");
    }
  };

  return { exporting, exportCSV, copyVisible };
}
