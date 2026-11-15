import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NonceProvider, useNonce } from "@/app/_components/NonceProvider";

function NonceConsumer() {
  return createElement("span", null, useNonce() ?? "sem-nonce");
}

const TestNonceProvider = NonceProvider as ComponentType<{ nonce?: string }>;

describe("NonceProvider", () => {
  it("expõe o nonce da resposta aos estilos criados no cliente", () => {
    const html = renderToStaticMarkup(
      createElement(TestNonceProvider, { nonce: "nonce-da-resposta" }, createElement(NonceConsumer)),
    );
    expect(html).toContain("nonce-da-resposta");
  });

  it("mantém fallback seguro quando a requisição não contém nonce", () => {
    expect(renderToStaticMarkup(createElement(NonceConsumer))).toContain("sem-nonce");
  });
});
