"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { isSuperAdmin, rotaInicial } from "@/lib/auth";
import Spinner from "@/components/Spinner";

/**
 * Multi-franquia — Etapa 5 ("Controle Geral", item 1 do escopo — "rota
 * protegida no backend também, não só escondida no frontend"). Este
 * componente é só a parte de UX: manda de volta pro Dashboard quem não é
 * SUPER_ADMIN antes mesmo de tentar chamar a API (evita um flash de tela
 * vazia seguido de erros 403). A proteção que realmente importa é a do
 * backend (middleware/exigirSuperAdmin.js) — um usuário de franquia
 * batendo direto na API, sem passar por este componente nenhuma, ainda
 * assim toma 403 em toda rota de /api/franquias e /api/usuarios.
 */
export default function RequireSuperAdmin({ children }) {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!isSuperAdmin()) {
      router.replace(rotaInicial());
      return;
    }
    setChecking(false);
  }, [router]);

  if (checking) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Spinner className="h-8 w-8" />
      </main>
    );
  }

  return children;
}
