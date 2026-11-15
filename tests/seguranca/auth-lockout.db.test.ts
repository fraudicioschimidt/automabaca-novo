import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  JANELA_MS,
  MAX_TENTATIVAS,
  MAX_TENTATIVAS_USERNAME,
  claimLoginAttempt,
  clientIpFromHeaders,
  completeLoginAttempt,
  loginAuditActor,
} from "@/src/services/auth/lockout";
import { privacyHash } from "@/src/infra/privacy";

/**
 * Lockout de login contra Postgres real — a contagem vive no AuditEvent. Tudo passa
 * pelo caminho da rota: `claimLoginAttempt` antes do scrypt e
 * `completeLoginAttempt` depois.
 */

let db: TestDb;
beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.dispose();
});
beforeEach(async () => {
  await db.reset();
});

const IP = "203.0.113.7";

/** Uma tentativa como a rota faz. Devolve se o lockout deixou tentar. */
async function tentar(username: string, ip: string, success = false): Promise<boolean> {
  const claim = await claimLoginAttempt({ username, ip });
  if (claim.allowed) await completeLoginAttempt({ claimId: claim.claimId, username, success });
  return claim.allowed;
}

async function nFalhas(n: number, username: string, ip: string) {
  for (let i = 0; i < n; i++) expect(await tentar(username, ip)).toBe(true);
}

describe("lockout de login", () => {
  it("trocar X-Real-IP não contorna o teto por IP atrás do Caddy", async () => {
    const claim = (attempt: number) => claimLoginAttempt({
      username: "proxy-spoof",
      ip: clientIpFromHeaders(new Headers({
        "x-real-ip": `198.51.100.${attempt}`,
        "x-forwarded-for": IP,
      })),
    });
    for (let attempt = 1; attempt <= MAX_TENTATIVAS; attempt++) {
      expect((await claim(attempt)).allowed).toBe(true);
    }
    expect((await claim(MAX_TENTATIVAS + 1)).allowed).toBe(false);
  });

  it("abaixo do teto não bloqueia; ao atingir o teto bloqueia", async () => {
    await nFalhas(MAX_TENTATIVAS - 1, "fab", IP);
    expect(await tentar("fab", IP)).toBe(true);
    expect(await tentar("fab", IP)).toBe(false);
  });

  it("login bem-sucedido zera a contagem", async () => {
    await nFalhas(MAX_TENTATIVAS - 1, "fab", IP);
    expect(await tentar("fab", IP, true)).toBe(true);
    // Sem o reset, a primeira destas já seria recusada.
    await nFalhas(MAX_TENTATIVAS, "fab", IP);
    expect(await tentar("fab", IP)).toBe(false);
  });

  it("falhas fora da janela não contam", async () => {
    const antigo = new Date(Date.now() - JANELA_MS - 60_000);
    for (let i = 0; i < MAX_TENTATIVAS; i++) {
      await db.prisma.auditEvent.create({
        data: {
          actor: loginAuditActor("fab"),
          action: "auth.login_failed",
          resource: "auth",
          outcome: "failure",
          details: { ipHash: privacyHash(IP, "ip") },
          createdAt: antigo,
        },
      });
    }
    expect(await tentar("fab", IP)).toBe(true);
  });

  it("isolamento: falhas de um usuário/IP não bloqueiam outro par", async () => {
    await nFalhas(MAX_TENTATIVAS, "fab", IP);
    expect(await tentar("outro", "198.51.100.2")).toBe(true);
  });

  it("falhas do mesmo IP em usuários diferentes NÃO travam outro username (par AND)", async () => {
    for (let i = 0; i < MAX_TENTATIVAS; i++) {
      expect(await tentar(`user${i}`, IP)).toBe(true);
    }
    // Par (usuario-novo, IP) ainda sem falhas — sem DoS de conta por username conhecido.
    expect(await tentar("usuario-novo", IP)).toBe(true);
  });

  it("sem IP confiável cai para lockout só por usuário", async () => {
    await nFalhas(MAX_TENTATIVAS, "fab", "");
    expect(await tentar("fab", "")).toBe(false);
    // Com IP presente, o escopo é o par — falhas sem IP não contam no par com IP.
    expect(await tentar("fab", "9.9.9.9")).toBe(true);
    expect(await tentar("zzz", "")).toBe(true);
  });

  it("mesmo username em IPs diferentes: cada par tem contagem própria", async () => {
    await nFalhas(MAX_TENTATIVAS, "fab", IP);
    expect(await tentar("fab", IP)).toBe(false);
    expect(await tentar("fab", "198.51.100.9")).toBe(true);
  });

  it("persiste somente o hash do IP na trilha de auditoria", async () => {
    await tentar("fab", IP);
    const row = await db.prisma.auditEvent.findFirstOrThrow({
      where: { action: "auth.login_failed" },
      select: { details: true },
    });
    expect(row.details).toEqual({ ipHash: privacyHash(IP, "ip") });
    expect(JSON.stringify(row.details)).not.toContain(IP);
  });

  it("não grava o username digitado: a trilha guarda só o hash, e o bloqueio conta por ele", async () => {
    // Senha digitada no campo usuário não pode ficar em claro na auditoria.
    const typed = "minha-senha-secreta";
    await nFalhas(MAX_TENTATIVAS, typed, IP);
    expect(await tentar(typed, IP)).toBe(false);
    const rows = await db.prisma.auditEvent.findMany({ where: { resource: "auth" } });
    expect(rows).toHaveLength(MAX_TENTATIVAS);
    expect(JSON.stringify(rows)).not.toContain(typed);
    expect(new Set(rows.map((row) => row.actor))).toEqual(new Set([loginAuditActor(typed)]));
    expect(loginAuditActor(typed)).toBe(`login:${privacyHash(typed, "username")}`);
  });

  it("IPv6 conta por /64: trocar o endereço dentro da mesma rede não renova o teto", async () => {
    for (let i = 1; i <= MAX_TENTATIVAS; i++) {
      expect(await tentar("fab", `2001:db8:abcd:12::${i.toString(16)}`)).toBe(true);
    }
    expect(await tentar("fab", "2001:0db8:abcd:0012:ffff:1:2:3")).toBe(false);
    expect(await tentar("fab", "2001:db8:abcd:13::1")).toBe(true);
  });

  it("IPv4 mapeado em IPv6 é a mesma origem do IPv4", async () => {
    await nFalhas(MAX_TENTATIVAS, "fab", IP);
    expect(await tentar("fab", `::ffff:${IP}`)).toBe(false);
  });

  it("claim concorrente reserva no máximo o teto do par antes do scrypt", async () => {
    const claims = await Promise.all(
      Array.from({ length: MAX_TENTATIVAS + 5 }, () =>
        claimLoginAttempt({ username: "burst", ip: IP })),
    );
    const allowed = claims.filter(
      (claim): claim is { allowed: true; claimId: string } => claim.allowed,
    );
    expect(allowed).toHaveLength(MAX_TENTATIVAS);
    expect(claims.filter((claim) => !claim.allowed)).toHaveLength(5);
    await Promise.all(allowed.map((claim) => completeLoginAttempt({
      claimId: claim.claimId,
      username: "burst",
      success: false,
    })));
    expect(await tentar("burst", IP)).toBe(false);
  });

  it("claim serializa o teto global mesmo com IPs diferentes", async () => {
    await db.prisma.auditEvent.createMany({
      data: Array.from({ length: MAX_TENTATIVAS_USERNAME - 5 }, (_, index) => ({
        actor: loginAuditActor("distributed"),
        action: "auth.login_failed",
        resource: "auth",
        outcome: "failure",
        details: { ipHash: privacyHash(`198.51.100.${index}`, "ip") },
      })),
    });
    const claims = await Promise.all(
      Array.from({ length: 10 }, (_, index) => claimLoginAttempt({
        username: "distributed",
        ip: `203.0.113.${index}`,
      })),
    );
    expect(claims.filter((claim) => claim.allowed)).toHaveLength(5);
    expect(claims.filter((claim) => !claim.allowed)).toHaveLength(5);
  });
});
