import { prisma } from "@/src/infra/prisma";

/**
 * Época de sessão por usuário, com estado no Postgres, em lookup dedicado.
 * O cookie carrega a época e a borda exige que ela seja a vigente. Login comum
 * cria uma sessão de dispositivo sem derrubar as demais; revogar é por
 * dispositivo (`device-sessions`), e o corte de todas é trocar a senha
 * (`sessionUser` em `infra/auth`). Nada gira a época hoje.
 */

/** Época atual do usuário em lookup O(1), ou null antes do primeiro login. */
export async function epochSessaoAtual(username: string): Promise<number | null> {
  const row = await prisma.authSessionState.findUnique({
    where: { username },
    select: { epoch: true },
  });
  return row ? Number(row.epoch) : null;
}

/**
 * Garante que o usuário TEM época, sem rotacionar nem revogar sessões.
 * Login comum e automação usam esta operação.
 *
 * Insert-only com ON CONFLICT DO NOTHING é idempotente sob corrida: quem
 * perde o insert só lê a época que o outro gravou.
 */
export async function garantirEpochSessao(username: string): Promise<number> {
  await prisma.$executeRaw`
    INSERT INTO auth_session_state (username, epoch, "updatedAt")
    VALUES (${username}, 1, now())
    ON CONFLICT (username) DO NOTHING
  `;
  const atual = await epochSessaoAtual(username);
  if (atual === null) throw new Error("Falha ao garantir época de sessão.");
  return atual;
}
