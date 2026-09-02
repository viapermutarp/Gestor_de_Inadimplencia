"use client";

import { useEffect, useState } from "react";
import { isSuperAdmin, getFranquiaSelecionada } from "@/lib/auth";
import { IconBuilding } from "@/components/icons";

/**
 * Multi-franquia — Etapa 5 ("Controle Geral", item 4 do escopo): protege
 * Dashboard/Cadastro/Contratos/Configurações/Taxa de Inadimplência — pra um
 * SUPER_ADMIN sem franquia selecionada (seletor no topo, ver
 * FranquiaSelector.js), essas telas não mostram nada, só um estado vazio
 * orientando a escolher. Pra um usuário de franquia comum (não
 * SUPER_ADMIN), nunca bloqueia nada — a franquia dele já é fixa, não existe
 * seleção. "Controle Geral" (app/controle-geral) é a única tela que NÃO usa
 * este guard, de propósito: é cross-franquia por natureza.
 */
export default function RequireFranquiaSelecionada({ children }) {
  const [precisaSelecionar, setPrecisaSelecionar] = useState(false);
  const [pronto, setPronto] = useState(false);

  useEffect(() => {
    setPrecisaSelecionar(isSuperAdmin() && !getFranquiaSelecionada());
    setPronto(true);
  }, []);

  if (!pronto) return null;

  if (precisaSelecionar) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-border-soft bg-surface px-6 py-16 text-center shadow-lg shadow-black/20">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary">
          <IconBuilding className="h-6 w-6" />
        </span>
        <h2 className="font-display text-lg font-bold text-foreground">Selecione uma franquia</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          Como SUPER_ADMIN, escolha uma franquia no seletor no topo da tela para ver os dados dela — cada
          tela mostra sempre os dados de uma única franquia por vez.
        </p>
      </div>
    );
  }

  return children;
}
