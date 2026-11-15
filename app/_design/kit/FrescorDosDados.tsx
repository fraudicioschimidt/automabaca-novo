"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { CADENCIA_DO_CARIMBO_MS, fonteDeFrescor, frescorDaFonte, type Frescor } from "@/src/domain/frescor";
import { algumaFonteAtrasada, textoDaTiraDeFrescor } from "../lib/frescor-na-tela";
import { useDesign } from "./context";
import { Tooltip } from "./Tooltip";

/**
 * A tira que diz de quando é o número logo acima: cinza discreto, e vermelho
 * só quando uma fonte COM cadência passou da tolerância (`src/domain/frescor`).
 * O servidor manda o instante (`emISO`) e a frase é recalculada aqui a cada
 * tique e ao voltar para a aba; o primeiro render usa o texto do servidor para
 * a hidratação bater.
 */
export function FrescorDosDados({ fontes, style }: { fontes: readonly Frescor[] | null | undefined; style?: CSSProperties }) {
  const { T } = useDesign();
  // `null` até montar: é o que faz o primeiro render do cliente bater com o SSR.
  const [agora, setAgora] = useState<Date | null>(null);

  useEffect(() => {
    const marcar = () => setAgora(new Date());
    const id = setInterval(marcar, CADENCIA_DO_CARIMBO_MS);
    const aoVoltar = () => { if (document.visibilityState === "visible") marcar(); };
    document.addEventListener("visibilitychange", aoVoltar);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", aoVoltar);
    };
  }, []);

  if (!fontes?.length) return null;

  const atuais = agora
    ? fontes.map((f) => frescorDaFonte(
        fonteDeFrescor(f.chave),
        f.emISO ? new Date(f.emISO) : null,
        agora,
      ))
    : fontes;

  const atrasada = algumaFonteAtrasada(atuais);
  return (
    <Tooltip
      titulo="De quando é este dado"
      texto={
        "Captura e fechamento seguem o relógio do mundo: envelhecem quando não há jogo, e isso não é falha. "
        + "Motor e ciclo de fechamento têm cadência própria — passar de três ciclos é atraso de verdade, e só esses ficam em vermelho."
      }
    >
      <span style={{ ...T.type.caption, color: atrasada ? T.neg : T.textFaint, ...style }}>
        {textoDaTiraDeFrescor(atuais)}
      </span>
    </Tooltip>
  );
}
