"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { login, ApiError } from "@/lib/api";
import { setSession, isAuthenticated } from "@/lib/auth";
import Spinner from "@/components/Spinner";

export default function LoginPage() {
  const router = useRouter();
  const [usuario, setUsuario] = useState("");
  const [senha, setSenha] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    if (isAuthenticated()) {
      router.replace("/dashboard");
      return;
    }
    setCheckingSession(false);
  }, [router]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    if (!usuario.trim() || !senha) {
      setError("Informe usuário e senha.");
      return;
    }

    setLoading(true);
    try {
      const data = await login(usuario.trim(), senha);
      if (!data?.token || !data?.refresh_token) {
        throw new ApiError("Resposta inválida do servidor.", 0);
      }
      setSession({ token: data.token, refreshToken: data.refresh_token });
      router.replace("/dashboard");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível entrar. Tente novamente.");
      setLoading(false);
    }
  }

  if (checkingSession) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Spinner className="h-8 w-8" />
      </main>
    );
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-48 left-1/2 h-[32rem] w-[32rem] -translate-x-1/2 rounded-full bg-primary/25 blur-[110px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0 right-0 h-72 w-72 translate-x-1/3 translate-y-1/3 rounded-full bg-accent/15 blur-3xl"
      />

      <div className="relative w-full max-w-sm rounded-3xl border border-border-soft bg-surface/90 p-8 shadow-2xl shadow-black/50 backdrop-blur">
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/30">
            <span className="font-mono text-sm font-bold tracking-tight">VP</span>
          </span>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Via Permuta</p>
          <h1 className="mt-2 font-display text-2xl font-bold text-foreground">Gestor de Inadimplência</h1>
          <p className="mt-1 text-sm text-muted-foreground">Acesso restrito à equipe de cobrança</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="usuario" className="mb-1.5 block text-sm font-medium text-muted-foreground">
              Usuário
            </label>
            <input
              id="usuario"
              type="text"
              autoComplete="username"
              value={usuario}
              onChange={(e) => setUsuario(e.target.value)}
              className="w-full rounded-xl border border-border-soft bg-surface-elevated px-3.5 py-2.5 text-foreground placeholder:text-muted/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
              placeholder="seu.usuario"
              disabled={loading}
            />
          </div>

          <div>
            <label htmlFor="senha" className="mb-1.5 block text-sm font-medium text-muted-foreground">
              Senha
            </label>
            <input
              id="senha"
              type="password"
              autoComplete="current-password"
              value={senha}
              onChange={(e) => setSenha(e.target.value)}
              className="w-full rounded-xl border border-border-soft bg-surface-elevated px-3.5 py-2.5 text-foreground placeholder:text-muted/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
              placeholder="••••••••"
              disabled={loading}
            />
          </div>

          {error && (
            <p className="rounded-xl border border-status-red/30 bg-status-red/10 px-3.5 py-2.5 text-sm text-foreground">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-70"
          >
            {loading && <Spinner className="h-4 w-4" />}
            {loading ? "Entrando..." : "Entrar"}
          </button>
        </form>
      </div>
    </main>
  );
}
