import { useEffect, useState } from "react";
import type { BankrollActions } from "../../action-contracts";
import { errorMessage, toast } from "../../toast";
import { sharpModeLabel } from "../../lib/sharp-mode";
import type { BankrollView } from "./types";

export type SharpModeKey = Parameters<NonNullable<BankrollActions["onChangeSharpMode"]>>[1];

/** Troca otimista do modo sharp: o selo muda na hora e volta se a action falhar. */
export function useSharpMode({ bk, onChangeSharpMode }: {
  bk: BankrollView["bk"];
  onChangeSharpMode: BankrollActions["onChangeSharpMode"];
}) {
  const [currentSharpMode, setCurrentSharpMode] = useState<string>(() => bk?.sharpMode || "CLV_ONLY");

  useEffect(() => {
    if (bk?.sharpMode) setCurrentSharpMode(bk.sharpMode);
  }, [bk?.sharpMode]);

  const handleChangeSharpMode = (newSharpMode: SharpModeKey) => {
    const prevMode = currentSharpMode;
    const label = sharpModeLabel(newSharpMode);
    setCurrentSharpMode(newSharpMode);

    if (!onChangeSharpMode || !bk) {
      toast(`Modo sharp alterado para: ${label}`, "ok");
      return;
    }

    return onChangeSharpMode(bk.slug, newSharpMode)
      .then(() => {
        toast(`Modo sharp alterado para: ${label}`, "ok");
      })
      .catch((error: unknown) => {
        setCurrentSharpMode(prevMode);
        toast(errorMessage(error, "Falha ao alterar modo sharp"), "warn");
      });
  };

  return { currentSharpMode, handleChangeSharpMode };
}
