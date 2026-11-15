import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DesignProvider } from "@/app/_design/kit/context";
import { BankrollLogo, SharpModeTag } from "@/app/_design/kit/primitives";
import { getTheme, type ThemeMode } from "@/app/_design/theme";
import { renderDesignMarkup } from "../helpers/design-markup";

function rgb(color: string): [number, number, number, number] {
  const rgba = color.match(/^rgba?\(([^)]+)\)$/);
  if (rgba) {
    const [r, g, b, a = "1"] = rgba[1]!.split(",").map((part) => part.trim());
    return [Number(r), Number(g), Number(b), Number(a)];
  }
  const hex = color.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(1) as [number, number, number, number];
}

function luminance([r, g, b]: number[]): number {
  const [lr, lg, lb] = [r!, g!, b!].map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!;
}

/** Contraste WCAG do texto sobre o fundo, com o fundo translúcido composto sobre `base`. */
function contrast(fg: string, bg: string, base: string): number {
  const [r, g, b, a] = rgb(bg);
  const under = rgb(base);
  const solid = [r, g, b].map((channel, i) => channel * a + under[i]! * (1 - a));
  const [x, y] = [luminance(rgb(fg)), luminance(solid)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function renderIn(mode: ThemeMode, ui: ReactElement): string {
  return renderToStaticMarkup(<DesignProvider mode={mode}>{ui}</DesignProvider>);
}

describe("SharpModeTag", () => {
  it("mostra o nome curto do modo, com o ponto na cor dele", () => {
    const T = getTheme("light");
    const clv = renderDesignMarkup(<SharpModeTag mode="CLV_ONLY" />);
    expect(clv).toContain(">CLV<");
    expect(clv).toContain(`background:${T.pos}`);
    const identity = renderDesignMarkup(<SharpModeTag mode="IDENTITY_ONLY" />);
    expect(identity).toContain(">Identidade<");
    expect(identity).toContain(`background:${T.brandAccent}`);
    const off = renderDesignMarkup(<SharpModeTag mode="OFF" />);
    expect(off).toContain(">Sem medição<");
    expect(off).toContain(`background:${T.textFaint}`);
    expect(renderDesignMarkup(<SharpModeTag mode="NOVO" />)).toContain(">NOVO<");
  });
});

describe("BankrollLogo", () => {
  it("com foto, mostra a foto", () => {
    const html = renderDesignMarkup(<BankrollLogo name="Big Data" logoUrl="/api/logos/main.png" toneKey="main" />);
    expect(html).toContain('src="/api/logos/main.png"');
  });

  it("sem foto, o tom segue o slug, não o nome", () => {
    const T = getTheme("light");
    const tone = (slug: string, name = "Big Data") => {
      const html = renderDesignMarkup(<BankrollLogo name={name} toneKey={slug} />);
      return T.avatarTones.find(([bg, fg]) => html.includes(`color:${fg}`) && html.includes(`background:${bg}`));
    };
    expect(tone("main")).toBeDefined();
    expect(tone("main", "Big Data renomeado")).toEqual(tone("main"));
    const slugs = ["main", "cestinha", "value-hunter", "corner-edge", "btts-lab", "northodds", "goalline-pro", "sharp-iberia"];
    expect(new Set(slugs.map((slug) => tone(slug)?.[0])).size).toBeGreaterThan(3);
  });

  it("a carteira (sem slug) fica no dourado da marca", () => {
    const T = getTheme("dark");
    const html = renderIn("dark", <BankrollLogo name="Carteira" toneKey={null} />);
    expect(html).toContain(`background:${T.brandAccent}`);
  });

  it("iniciais: duas palavras ou duas letras", () => {
    expect(renderDesignMarkup(<BankrollLogo name="  Big   Data  " toneKey="a" />)).toContain(">BD<");
    expect(renderDesignMarkup(<BankrollLogo name="Cestinha" toneKey="a" />)).toContain(">CE<");
    expect(renderDesignMarkup(<BankrollLogo name="⚽ Gol Certo" toneKey="a" />)).toContain(">GC<");
  });

  it("todo tom tem texto com 4,5:1 ou mais, nos dois temas", () => {
    for (const mode of ["light", "dark"] as const) {
      const T = getTheme(mode);
      for (const [bg, fg] of T.avatarTones) {
        for (const base of [T.surface, T.surface2]) {
          expect(contrast(fg, bg, base), `${mode} ${bg} ${fg} sobre ${base}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});
