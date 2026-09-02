"use client";

import { useEffect, useRef, useState } from "react";
import { listarFranquias, ApiError } from "@/lib/api";
import { getFranquiaSelecionada, setFranquiaSelecionada } from "@/lib/auth";
import Spinner from "@/components/Spinner";
import { IconBuilding, IconChevronDown } from "@/components/icons";

/**
 * Multi-franquia — Etapa 5 ("Controle Geral", item 4 do escopo): seletor de
 * franquia fixo no topo, só pro SUPER_ADMIN — "trocar de conta". Enquanto
 * não houver seleção, Dashboard/Cadastro/Contratos/Configurações/Taxa de
 * Inadimplência ficam num estado vazio orientando a escolher aqui (ver
 * RequireFranquiaSelecionada.js). A lista é buscada de novo toda vez que o
 * dropdown abre — evita mostrar uma franquia recém-criada como desatualizada
 * sem precisar de nenhuma sincronização entre componentes.
 */
export default function FranquiaSelector() {
  const [aberto, setAberto] = useState(false);
  const [franquias, setFranquias] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  const [selecionadaId, setSelecionadaId] = useState(null);
  const containerRef = useRef(null);

  useEffect(() => {
    setSelecionadaId(getFranquiaSelecionada());
  }, []);

  useEffect(() => {
    function aoClicarFora(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setAberto(false);
      }
    }
    document.addEventListener("mousedown", aoClicarFora);
    return () => document.removeEventListener("mousedown", aoClicarFora);
  }, []);

  async function abrir() {
    setAberto((v) => !v);
    if (!aberto) {
      setCarregando(true);
      setErro("");
      try {
        const data = await listarFranquias();
        setFranquias(Array.isArray(data) ? data : []);
      } catch (err) {
        setErro(err instanceof ApiError ? err.message : "Erro ao carregar franquias.");
      } finally {
        setCarregando(false);
      }
    }
  }

  function escolher(franquia) {
    setFranquiaSelecionada(franquia.id);
    setAberto(false);
    // Navegação "dura" de propósito (não router.push): garante que toda
    // página/componente já montado remonte do zero com a franquia nova (ver
    // comentário em lib/api.js:comFranquiaSelecionada) — trocar de franquia
    // é uma ação administrativa rara; o custo de um reload completo é
    // aceitável e bem mais simples/robusto do que sincronizar o estado de
    // cada página independente entre si. As 2 regras de lint abaixo
    // assumem que toda navegação interna deveria ser client-side
    // (router.push) — aqui é deliberadamente o oposto.
    // eslint-disable-next-line react-hooks/immutability, @next/next/no-location-assign-relative-destination
    window.location.href = "/dashboard";
  }

  const atual = franquias.find((f) => f.id === selecionadaId);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={abrir}
        className="flex items-center gap-2 rounded-xl border border-border-soft bg-surface px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary/40"
      >
        <IconBuilding className="h-4 w-4 text-accent" />
        <span className="max-w-[9rem] truncate sm:max-w-[14rem]">
          {atual ? atual.nome : selecionadaId ? "Franquia selecionada" : "Selecionar franquia"}
        </span>
        <IconChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>

      {aberto && (
        <div className="absolute right-0 z-40 mt-2 w-72 rounded-xl border border-border-soft bg-surface-elevated p-2 shadow-2xl shadow-black/40">
          <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Trocar de franquia
          </p>

          {carregando ? (
            <div className="flex justify-center py-5">
              <Spinner className="h-4 w-4" />
            </div>
          ) : erro ? (
            <p className="px-2 py-2 text-xs text-status-red">{erro}</p>
          ) : franquias.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">Nenhuma franquia cadastrada ainda.</p>
          ) : (
            <ul className="mt-1 max-h-64 space-y-0.5 overflow-y-auto">
              {franquias.map((franquia) => (
                <li key={franquia.id}>
                  <button
                    type="button"
                    onClick={() => escolher(franquia)}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                      franquia.id === selecionadaId
                        ? "bg-primary/15 text-primary"
                        : "text-foreground hover:bg-surface"
                    }`}
                  >
                    <span className="min-w-0 truncate">{franquia.nome}</span>
                    {!franquia.ativo && (
                      <span className="shrink-0 rounded-full bg-status-red/15 px-2 py-0.5 text-[10px] font-medium text-status-red">
                        Inativa
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
