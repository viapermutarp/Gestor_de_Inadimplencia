"use client";

import { useEffect, useRef, useState } from "react";
import { IconCheck, IconChevronDown } from "@/components/icons";

const OPCOES = [
  { chave: "emNegociacao", label: "Em negociação" },
  { chave: "bloqueado", label: "Bloqueado" },
  { chave: "emJuridico", label: "Jurídico" },
];

/**
 * Filtro consolidado "Status do associado" — substitui os três dropdowns
 * separados (Renegociação/Jurídico/Bloqueado) por um único multi-select em
 * dropdown, com um checkbox independente por opção. `value` é um objeto
 * `{ emNegociacao, bloqueado, emJuridico }` de booleanos; marcado vira
 * "sim" na chamada à API (ver app/inadimplencia/page.js), desmarcado vira
 * "todos" (sem restringir aquele filtro) — os três se combinam com E
 * quando mais de um está marcado.
 *
 * Mesmo padrão visual do DatePicker (botão com borda + painel flutuante em
 * `surface-elevated`, fecha ao clicar fora) para não introduzir um novo
 * estilo de dropdown na tela.
 */
export default function StatusAssociadoFilter({ value, onChange }) {
  const [aberto, setAberto] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    function handleClickFora(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setAberto(false);
      }
    }
    document.addEventListener("mousedown", handleClickFora);
    return () => document.removeEventListener("mousedown", handleClickFora);
  }, []);

  const quantidadeAtiva = OPCOES.filter((o) => value?.[o.chave]).length;

  function alternar(chave) {
    onChange({ ...value, [chave]: !value?.[chave] });
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setAberto((prev) => !prev)}
        className="flex w-full items-center justify-between gap-2 rounded-xl border border-border-soft bg-surface px-3.5 py-2.5 text-left text-sm text-foreground transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
      >
        {quantidadeAtiva > 0 ? (
          <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold text-primary">
            {quantidadeAtiva} {quantidadeAtiva === 1 ? "filtro ativo" : "filtros ativos"}
          </span>
        ) : (
          <span className="text-muted/60">Todos</span>
        )}
        <IconChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${aberto ? "rotate-180" : ""}`}
        />
      </button>

      {aberto && (
        <div className="absolute z-40 mt-2 w-60 rounded-2xl border border-border-soft bg-surface-elevated p-2 shadow-2xl shadow-black/50">
          {OPCOES.map((o) => {
            const checked = Boolean(value?.[o.chave]);
            return (
              <button
                key={o.chave}
                type="button"
                onClick={() => alternar(o.chave)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-surface-hover"
              >
                <span
                  className={`flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-md border transition-colors ${
                    checked ? "border-primary bg-primary text-primary-foreground" : "border-border-soft"
                  }`}
                >
                  {checked && <IconCheck className="h-3 w-3" />}
                </span>
                {o.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
