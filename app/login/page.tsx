"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { BrandMark, BrandWordmark } from "@/app/_components/Brand";
import { safeReturnPath } from "@/src/domain/safe-return-path";
import styles from "./login.module.css";

/** Login: papel quente, painel central 360px, marca, dois inputs, botão
 * primário dourado. Nada mais — o respiro é o luxo aqui. */
function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(body?.error ?? "Não foi possível entrar.");
        return;
      }
      router.push(safeReturnPath(params.get("next")) ?? "/");
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.panel}>
        <div className={styles.brand}>
          <BrandMark size={40} />
          <BrandWordmark />
          <p className={styles.tagline}>Entre para acompanhar a operação</p>
        </div>

        <form
          onSubmit={submit}
          className={styles.form}
        >
          <label htmlFor="username" className={`eyebrow ${styles.label}`}>Usuário</label>
          <input
            id="username"
            name="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "login-error" : undefined}
            className={`input ${styles.field} ${styles.fieldUser}`}
          />
          <label htmlFor="password" className={`eyebrow ${styles.label}`}>Senha</label>
          <input
            id="password"
            name="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "login-error" : undefined}
            className={`input num ${styles.field} ${styles.fieldPassword}`}
          />
          {error ? (
            <p id="login-error" role="alert" className={styles.error}>
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={loading || !username || !password}
            className={`btn btn-primary ${styles.submit}`}
          >
            {loading ? "Verificando…" : "Entrar"}
          </button>
        </form>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
