"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { clearToken, isSuperAdmin, temRecurso } from "@/lib/auth";
import { logout } from "@/lib/api";
import { IconLogout, IconShield } from "@/components/icons";
import FranquiaSelector from "@/components/FranquiaSelector";

// "recurso": chave de RECURSOS (ver backend/src/config/recursos.js) — cada
// link só aparece se `temRecurso(recurso)` for true pra sessão atual (ver
// abaixo). Jurídico entra entre Taxa de Inadimplência e Cadastro, exatamente
// como pedido no escopo.
const NAV_LINKS = [
  { href: "/dashboard", label: "Dashboard", recurso: "dashboard" },
  { href: "/inadimplencia", label: "Taxa de Inadimplência %", recurso: "inadimplencia" },
  { href: "/juridico", label: "Jurídico", recurso: "juridico" },
  { href: "/cadastro", label: "Cadastro", recurso: "cadastro" },
  { href: "/contratos", label: "Contratos", recurso: "contratos" },
  { href: "/configuracoes", label: "Configurações", recurso: "configuracoes" },
];

// Multi-franquia — Etapa 5 ("Controle Geral"): visível só pro SUPER_ADMIN —
// a proteção de verdade é no backend (middleware/exigirSuperAdmin.js); isso
// aqui é só pra não oferecer um link que qualquer outro papel não pode usar.
const LINK_CONTROLE_GERAL = { href: "/controle-geral", label: "Controle Geral" };

export default function AppHeader() {
  const pathname = usePathname();
  const router = useRouter();
  // Calculado só depois de montar (lê localStorage) — evita divergência
  // entre a primeira renderização do servidor/cliente (ambas começam com
  // `false`) e a real, que só existe no navegador.
  const [souSuperAdmin, setSouSuperAdmin] = useState(false);
  // Restrição de telas por franquia (ver escopo do pedido, item 2.3): só
  // mostra o link de tela liberada pra franquia da sessão — mesmo motivo
  // de "montado" acima (evita mismatch de SSR/hidratação). Começa `null`
  // ("ainda não sei") pra não piscar todos os links e depois sumir com
  // alguns; enquanto `null`, mostra só os que não dependem de recurso
  // nenhum (nenhum, na prática — todos os 6 são restringíveis).
  const [recursosLiberados, setRecursosLiberados] = useState(null);

  useEffect(() => {
    setSouSuperAdmin(isSuperAdmin());
    setRecursosLiberados(NAV_LINKS.filter((link) => temRecurso(link.recurso)).map((link) => link.href));
  }, []);

  const navLinksVisiveis = recursosLiberados
    ? NAV_LINKS.filter((link) => recursosLiberados.includes(link.href))
    : [];
  const links = souSuperAdmin ? [...navLinksVisiveis, LINK_CONTROLE_GERAL] : navLinksVisiveis;

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
          {links.map((link) => {
            const active = pathname === link.href;
            const ehControleGeral = link.href === LINK_CONTROLE_GERAL.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 font-medium transition-colors ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : ehControleGeral
                      ? "text-accent hover:text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {ehControleGeral && <IconShield className="h-3.5 w-3.5" />}
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          {souSuperAdmin && <FranquiaSelector />}
          <button
            type="button"
            onClick={handleLogout}
            className="flex shrink-0 items-center gap-1.5 rounded-xl border border-border-soft px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:border-status-red/40 hover:text-status-red"
          >
            <IconLogout className="h-4 w-4" />
            <span className="hidden sm:inline">Sair</span>
          </button>
        </div>
      </div>

      <nav className="flex items-center gap-1 border-t border-border-soft px-4 py-2 text-sm sm:hidden">
        {links.map((link) => {
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

      {souSuperAdmin && (
        <div className="border-t border-border-soft px-4 py-2 sm:hidden">
          <FranquiaSelector />
        </div>
      )}
    </header>
  );
}
