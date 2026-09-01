"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { clearToken } from "@/lib/auth";
import { logout } from "@/lib/api";
import { IconLogout } from "@/components/icons";

const NAV_LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/inadimplencia", label: "Taxa de Inadimplência %" },
  { href: "/cadastro", label: "Cadastro" },
  { href: "/contratos", label: "Contratos" },
  { href: "/configuracoes", label: "Configurações" },
];

export default function AppHeader() {
  const pathname = usePathname();
  const router = useRouter();

  function handleLogout() {
    // Revoga a sessão no servidor (o refresh token fica inválido, então
    // ninguém consegue renová-la de novo) — best-effort, dispara e não
    // espera: se a rede falhar aqui, o usuário ainda assim sai localmente
    // (clearToken já resolve isso do lado do navegador) e a sessão expira
    // sozinha mais tarde. Precisa ler o refresh token ANTES de limpar.
    logout().catch(() => {});
    clearToken();
    router.replace("/login");
  }

  return (
    <header className="sticky top-0 z-30 border-b border-border-soft bg-surface/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3.5 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <span className="font-mono text-xs font-bold tracking-tight">VP</span>
          </span>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">Via Permuta</p>
            <h1 className="font-display text-base font-bold leading-tight text-foreground">
              Gestor de Inadimplência
            </h1>
          </div>
        </div>

        <nav className="hidden items-center gap-1 rounded-xl border border-border-soft bg-surface p-1 text-sm sm:flex">
          {NAV_LINKS.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`rounded-lg px-3.5 py-1.5 font-medium transition-colors ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <button
          type="button"
          onClick={handleLogout}
          className="flex shrink-0 items-center gap-1.5 rounded-xl border border-border-soft px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:border-status-red/40 hover:text-status-red"
        >
          <IconLogout className="h-4 w-4" />
          <span className="hidden sm:inline">Sair</span>
        </button>
      </div>

      <nav className="flex items-center gap-1 border-t border-border-soft px-4 py-2 text-sm sm:hidden">
        {NAV_LINKS.map((link) => {
          const active = pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`rounded-lg px-3 py-1.5 font-medium transition-colors ${
                active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
