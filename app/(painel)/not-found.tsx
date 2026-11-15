import { NaoEncontrado } from "@/app/_components/NaoEncontrado";

/**
 * `notFound()` lançado DENTRO do painel (aposta inexistente, banca com slug
 * trocado). Fica no grupo para herdar o chrome: o operador continua com a
 * sidebar e a navegação, em vez de cair numa tela órfã.
 */
export default function PainelNotFound() {
  return (
    <NaoEncontrado
      titulo="Não encontramos este registro"
      descricao="A aposta ou o tipster não existe, mudou de nome ou saiu da operação (👎 / encerrada)."
    />
  );
}
