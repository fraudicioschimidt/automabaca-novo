import { NextResponse } from "next/server";
import { isValidLogoFileName, LOGO_CONTENT_TYPES, readLogo } from "@/src/services/painel/logos";
import { sniffLogoExt, type LogoExt } from "@/src/services/logos/storage";
import { observedRoute } from "@/src/services/ops/http-telemetry";

export const dynamic = "force-dynamic";

/**
 * Serve as logos de tipster do diretório durável (LOGOS_DIR) — necessário
 * porque o web roda do bundle standalone e uploads pós-build não existem no
 * `public/` empacotado. Protegida pelo proxy (exige sessão, como o painel).
 */
async function handleGet(
  _request: Request,
  { params }: { params: Promise<{ file: string }> },
): Promise<NextResponse> {
  const { file } = await params;
  if (!isValidLogoFileName(file)) {
    return NextResponse.json({ error: "Nome de logo inválido." }, { status: 400 });
  }
  const buffer = await readLogo(file);
  if (!buffer) return NextResponse.json({ error: "Logo não encontrada." }, { status: 404 });

  const requestedExt = file.split(".").pop() as LogoExt;
  const sniffedExt = sniffLogoExt(buffer);
  const sameJpeg = sniffedExt === "jpg" && (requestedExt === "jpg" || requestedExt === "jpeg");
  if (!sniffedExt || (sniffedExt !== requestedExt && !sameJpeg)) {
    return NextResponse.json({ error: "Conteúdo da logo não corresponde ao formato." }, {
      status: 415,
      headers: { "x-content-type-options": "nosniff" },
    });
  }
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "content-type": LOGO_CONTENT_TYPES[sniffedExt],
      "x-content-type-options": "nosniff",
      // Sem `immutable`: o ?v=mtime muda quando o arquivo muda, mas um cliente
      // que segurou o URL antigo ficaria 24h sem poder revalidar — ruim quando a
      // substituição é justamente para tirar um logo do ar.
      "cache-control": "private, max-age=86400, must-revalidate",
    },
  });
}

// Uma logo por linha da tela: gravar métrica de cada sucesso enchia a tabela
// sem dizer nada. Falha técnica continua medida, como na rota de versão.
export const GET = observedRoute("/api/logos/[file]", handleGet, { metric: "errors" });
