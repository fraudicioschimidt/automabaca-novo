import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
export function sourceSnapshot(root = process.cwd()) {
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const files = [...new Set(git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean))]
    .filter((file) => !file.endsWith(".md")).sort();
  const hashes = files.map((file) => [file, existsSync(`${root}/${file}`) ? sha256(readFileSync(`${root}/${file}`)) : null]);
  return {
    commit: git(["rev-parse", "HEAD"]),
    dirty: git(["status", "--porcelain"]) !== "",
    sourceSha256: sha256(JSON.stringify(hashes)),
    packageLockSha256: sha256(readFileSync(`${root}/package-lock.json`)),
    migrations: hashes.filter(([file]) => file.startsWith("prisma/migrations/")),
  };
}

export function verifyChecks(snapshot, checks) {
  for (const name of ["static", "database", "browser", "build", "package", "rust"]) {
    const check = checks.find((item) => item.name === name);
    if (!check || check.exitCode !== 0) throw new Error(`Verificação ausente ou reprovada: ${name}`);
    if (check.source.sourceSha256 !== snapshot.sourceSha256) throw new Error(`Fonte mudou após a verificação: ${name}`);
  }
}
