"use client";

import { useEffect, useRef, useState } from "react";
import { IconCheck, IconChevronDown } from "@/components/icons";

const OPCOES_CHECKBOX = [
  { chave: "emNegociacao", label: "Em negociação" },
  { chave: "bloqueado", label: "Bloqueado" },
];

// "Jurídico" (reunião Suelen + Roberto, 08/09) — deixou de ser um checkbox
// simples (só "todos"/"sim") e virou 3 opções mutuamente exclusivas, pra
// separar "Inadimplente Ativo" (associado ainda com a equipe, não foi pro
// Jurídico — recuperável com esforço ativo) de "Inadimplente Jurídico" (já
// "escapou" pra lá, mais difícil de reaver). O backend já tinha o parâmetro
// tri-estado completo desde sempre (`em_juridico=todos|sim|nao`, ver
// `validarFiltroTriEstado`/`aplicarFiltrosCrossReference` em
// inadimplencia.controller.js — usado sem mudança nenhuma aqui); só a UI
// que não expunha a opção "nao" ("Só ativos"). Combina com o período e com
// o toggle "Em aberto hoje"/"Histórico do período" do mesmo jeito que
// "Em negociação"/"Bloqueado" já combinam.
const OPCOES_JURIDICO = [
  { valor: "todos", label: "Todos" },
  { valor: "ativos", label: "Só ativos (fora do Jurídico)" },
  { valor: "juridico", label: "Só Jurídico" },
];

/**
 * Filtro consolidado "Status do associado". `value` é um objeto
 * `{ emNegociacao, bloqueado, emJuridico }` — "emNegociacao"/"bloqueado"
 * continuam booleanos (checkbox; marcado vira "sim" na chamada à API,
 * desmarcado vira "todos" — ver app/inadimplencia/page.js); "emJuridico"
 * passou a ser uma string `"todos" | "ativos" | "juridico"` (mapeada pra
 * "todos"|"nao"|"sim" na chamada à API). Os três se combinam com E quando
 * mais de um está ativo (checkbox marcado e/ou jurídico != "todos").
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

  const emJuridicoAtivo = value?.emJuridico && value.emJuridico !== "todos";
  const quantidadeAtiva = OPCOES_CHECKBOX.filter((o) => value?.[o.chave]).length + (emJuridicoAtivo ? 1 : 0);

  function alternarCheckbox(chave) {
    onChange({ ...value, [chave]: !value?.[chave] });
  }

  function selecionarJuridico(valor) {
    onChange({ ...value, emJuridico: valor });
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
        <div className="absolute z-40 mt-2 w-64 rounded-2xl border border-border-soft bg-surface-elevated p-2 shadow-2xl shadow-black/50">
          {OPCOES_CHECKBOX.map((o) => {
            const checked = Boolean(value?.[o.chave]);
            return (
              <button
                key={o.chave}
                type="button"
                onClick={() => alternarCheckbox(o.chave)}
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

          <div className="my-1.5 border-t border-border-soft" />
          <p className="px-2.5 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Jurídico
          </p>
          {OPCOES_JURIDICO.map((o) => {
            const selecionado = (value?.emJuridico || "todos") === o.valor;
            return (
              <button
                key={o.valor}
                type="button"
                onClick={() => selecionarJuridico(o.valor)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-surface-hover"
              >
                <span
                  className={`flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border transition-colors ${
                    selecionado ? "border-primary bg-primary text-primary-foreground" : "border-border-soft"
                  }`}
                >
                  {selecionado && <IconCheck className="h-3 w-3" />}
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
