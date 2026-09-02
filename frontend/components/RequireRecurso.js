"use client";

import { useEffect, useState } from "react";
import { temRecurso } from "@/lib/auth";
import Spinner from "@/components/Spinner";
import { IconLock } from "@/components/icons";

/**
 * Restrição de telas por franquia (ver escopo do pedido, item 2.3 —
 * "se tentar acessar direto pela URL uma tela sem permissão, mostra uma
 * tela de 'sem acesso', não quebra a aplicação"). Uso: envolve o conteúdo
 * de cada layout restringível — `<RequireRecurso chave="contratos">`.
 *
 * Só UX (mesma ressalva de RequireSuperAdmin.js): decide a partir do claim
 * "recursosPermitidos" do access token, que pode ficar desatualizado até
 * ele expirar (15min por padrão) se o SUPER_ADMIN mudar os recursos da
 * franquia no meio da sessão — ver lib/auth.js:temRecurso. A proteção que
 * realmente importa é o backend (middleware/exigirRecurso.js, checado a
 * cada requisição); se o claim ficar stale e deixar passar, as chamadas de
 * API da tela tomam 403 normalmente e mostram o erro de sempre.
 */
export default function RequireRecurso({ chave, children }) {
  const [semAcesso, setSemAcesso] = useState(false);
  const [pronto, setPronto] = useState(false);

  useEffect(() => {
    setSemAcesso(!temRecurso(chave));
    setPronto(true);
  }, [chave]);

  if (!pronto) {
    return (
      <div className="flex justify-center py-16">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (semAcesso) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-border-soft bg-surface px-6 py-16 text-center shadow-lg shadow-black/20">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-status-red/15 text-status-red">
          <IconLock className="h-6 w-6" />
        </span>
        <h2 className="font-display text-lg font-bold text-foreground">Sem acesso a esta tela</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          Sua franquia não tem esta tela liberada. Fale com o administrador geral se precisar de acesso.
        </p>
      </div>
    );
  }

  return children;
}
