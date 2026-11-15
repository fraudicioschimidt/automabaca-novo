import { createHmac, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authenticate,
  createSessionValue,
  parseAuthUsers,
  sessionUser,
  verifyPassword,
  verifySessionValue,
  type AuthUser,
} from "@/src/infra/auth";

/**
 * Auth do painel (porta para o painel de dinheiro real). Funções puras, único
 * arnês de segurança — uma regressão aqui (aceitar token sem assinatura, pular
 * o exp, hash malformado virar "ok") abriria o painel sem nenhum teste falhar.
 */

const SECRET = "x".repeat(48);

/** Hash no formato do projeto: scrypt$salt$hashhex (keylen 32, salt = hex). */
function makeHash(password: string, salt = "a1b2c3d4e5f60718"): string {
  const hex = scryptSync(password, salt, 32).toString("hex");
  return `scrypt$${salt}$${hex}`;
}

/** Forja uma sessão com payload arbitrário + assinatura HMAC válida. */
function forgeSession(payload: object, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

const nowS = () => Math.floor(Date.now() / 1000);

describe("verifyPassword", () => {
  it("aceita a senha correta e rejeita a errada", async () => {
    const stored = makeHash("segredo-forte");
    expect(await verifyPassword("segredo-forte", stored)).toBe(true);
    expect(await verifyPassword("segredo-errado", stored)).toBe(false);
  });

  it("rejeita formato de hash malformado sem estourar", async () => {
    expect(await verifyPassword("x", "naoehscrypt")).toBe(false);
    expect(await verifyPassword("x", "scrypt$semHashFinal")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$salt$00ff")).toBe(false); // esquema errado
    expect(await verifyPassword("x", "scrypt$salt$zz")).toBe(false); // hex inválido
    expect(await verifyPassword("x", "scrypt$salt$abc")).toBe(false); // hex de tamanho ímpar
    expect(await verifyPassword("x", "")).toBe(false);
  });

  it("candidato de tamanho diferente do hash não estoura e dá false", async () => {
    const stored = makeHash("senha");
    await expect(verifyPassword("", stored)).resolves.toBe(false);
  });

  it("o scrypt não prende a thread principal enquanto calcula", async () => {
    // Um login em curso não pode parar as páginas do dono servidas pelo mesmo processo.
    const stored = makeHash("segredo-forte");
    let loopRan = false;
    const pending = verifyPassword("segredo-forte", stored);
    setImmediate(() => { loopRan = true; });
    await expect(pending).resolves.toBe(true);
    expect(loopRan).toBe(true);
  });
});

describe("parseAuthUsers", () => {
  it("vazio/undefined → lista vazia", () => {
    expect(parseAuthUsers(undefined)).toEqual([]);
    expect(parseAuthUsers("")).toEqual([]);
  });

  it("aceita o formato novo e o legado com papel, ignorando a terceira parte", () => {
    // O painel não tem mais papéis; configuração legada (`user:hash:admin`)
    // não pode parar de autenticar por causa disso.
    const raw = `alice:${makeHash("a")},bob:${makeHash("b")}:admin,carol:${makeHash("c")}:bogus`;
    const users = parseAuthUsers(raw);
    expect(users.map((u) => u.username)).toEqual(["alice", "bob", "carol"]);
  });

  it("ignora entradas malformadas (sem hash)", () => {
    expect(parseAuthUsers("semhash,,:")).toEqual([]);
  });

  it("des-escapa \\$ do .env e o usuário resultante autentica ponta a ponta", async () => {
    const escaped = makeHash("minha-senha").replace(/\$/g, "\\$");
    const users = parseAuthUsers(`dono:${escaped}:admin`);
    expect(users).toHaveLength(1);
    expect(await authenticate("dono", "minha-senha", users)).toMatchObject({ username: "dono" });
    expect(await authenticate("dono", "senha-errada", users)).toBeNull();
  });
});

describe("authenticate", () => {
  const users: AuthUser[] = [
    { username: "fab", passwordHash: makeHash("ok") },
  ];
  it("usuário inexistente → null", async () => {
    expect(await authenticate("ninguem", "ok", users)).toBeNull();
  });
  it("senha errada → null; senha certa → user", async () => {
    expect(await authenticate("fab", "nope", users)).toBeNull();
    expect(await authenticate("fab", "ok", users)).toMatchObject({ username: "fab" });
  });
});

describe("createSessionValue / verifySessionValue", () => {
  const user: AuthUser = { username: "fab", passwordHash: makeHash("ok") };
  const EPOCH = 1_700_000_000_000;

  it("round-trip devolve username e epoch", () => {
    const value = createSessionValue(user, SECRET, EPOCH);
    expect(verifySessionValue(value, SECRET)).toEqual({
      username: "fab",
      epoch: EPOCH,
      passwordFingerprint: expect.any(String),
    });
  });

  it("round-trip preserva vínculo opcional com dispositivo", () => {
    const value = createSessionValue(user, SECRET, EPOCH, { id: "device-1", token: "token-1" });
    expect(verifySessionValue(value, SECRET)).toEqual({
      username: "fab",
      epoch: EPOCH,
      passwordFingerprint: expect.any(String),
      sessionId: "device-1",
      sessionToken: "token-1",
    });
  });

  it("assinatura adulterada → null", () => {
    const value = createSessionValue(user, SECRET, EPOCH);
    const [encoded, sig] = value.split(".");
    const flipped = `${encoded}.${sig!.slice(0, -1)}${sig!.at(-1) === "a" ? "b" : "a"}`;
    expect(verifySessionValue(flipped, SECRET)).toBeNull();
  });

  it("payload adulterado sem reassinar → null", () => {
    const value = createSessionValue(user, SECRET, EPOCH);
    const [, sig] = value.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ u: "fab", r: "admin", exp: nowS() + 1000, e: EPOCH }),
    ).toString("base64url");
    expect(verifySessionValue(`${forgedPayload}.${sig}`, SECRET)).toBeNull();
  });

  it("sessão expirada → null", () => {
    const expirada = forgeSession({ u: "fab", r: "admin", exp: nowS() - 10, e: EPOCH }, SECRET);
    expect(verifySessionValue(expirada, SECRET)).toBeNull();
  });

  it("cookie sem época → null — força re-login", () => {
    const antiga = forgeSession({ u: "fab", r: "admin", exp: nowS() + 1000 }, SECRET);
    expect(verifySessionValue(antiga, SECRET)).toBeNull();
  });

  it("segredo errado → null", () => {
    const value = createSessionValue(user, SECRET, EPOCH);
    expect(verifySessionValue(value, "outro-segredo-qualquer-com-32+chars!!")).toBeNull();
  });

  it("entradas degeneradas → null (nunca estoura)", () => {
    expect(verifySessionValue(undefined, SECRET)).toBeNull();
    expect(verifySessionValue("", SECRET)).toBeNull();
    expect(verifySessionValue("semponto", SECRET)).toBeNull();
    expect(verifySessionValue("a.b.c", SECRET)).toBeNull();
    // assinatura VÁLIDA sobre conteúdo que não é JSON → JSON.parse lança → catch → null.
    const lixo = Buffer.from("isto não é json {").toString("base64url");
    const sig = createHmac("sha256", SECRET).update(lixo).digest("base64url");
    expect(verifySessionValue(`${lixo}.${sig}`, SECRET)).toBeNull();
  });

  it("cookie legado com papel continua válido — o campo é ignorado", () => {
    // O painel não tem mais papéis. Cookie legado não pode deslogar o
    // operador: o `r` sobra no payload e não participa de nada.
    const value = forgeSession({ u: "fab", r: "admin", exp: nowS() + 1000, e: EPOCH }, SECRET);
    expect(verifySessionValue(value, SECRET)).toMatchObject({ username: "fab" });
  });
});

describe("sessionUser", () => {
  const EPOCH = 1;
  const leaked: AuthUser = { username: "fab", passwordHash: makeHash("senha-vazada") };
  const session = (user: AuthUser) =>
    verifySessionValue(createSessionValue(user, SECRET, EPOCH, { id: "device-1", token: "token-1" }), SECRET)!;

  it("trocar a senha em AUTH_USERS derruba a sessão aberta com a senha antiga", () => {
    const open = session(leaked);
    expect(sessionUser(open, [leaked], SECRET)).toEqual(leaked);
    const changed: AuthUser = { username: "fab", passwordHash: makeHash("senha-nova") };
    expect(sessionUser(open, [changed], SECRET)).toBeNull();
    expect(sessionUser(session(changed), [changed], SECRET)).toEqual(changed);
  });

  it("usuário fora de AUTH_USERS e cookie sem a impressão da senha não autenticam", () => {
    expect(sessionUser(session(leaked), [{ ...leaked, username: "outro" }], SECRET)).toBeNull();
    // Cookie emitido antes da impressão: o dono entra de novo uma vez.
    const semImpressao = verifySessionValue(
      forgeSession({ u: "fab", exp: nowS() + 1000, e: EPOCH, s: "device-1", t: "token-1" }, SECRET),
      SECRET,
    )!;
    expect(semImpressao).not.toBeNull();
    expect(sessionUser(semImpressao, [leaked], SECRET)).toBeNull();
  });

  it("o cookie não carrega o hash da senha", () => {
    const [encoded] = createSessionValue(leaked, SECRET, EPOCH).split(".");
    const payload = Buffer.from(encoded!, "base64url").toString("utf8");
    expect(payload).not.toContain(leaked.passwordHash.split("$")[2]!.slice(0, 16));
  });
});
