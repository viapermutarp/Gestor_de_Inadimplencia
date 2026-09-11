"use client";

import { useEffect, useRef, useState } from "react";
import { IconCheck, IconChevronDown } from "@/components/icons";

/**
 * Dropdown genérico de seleção múltipla por checkbox, com uma opção
 * especial "Todas"/"Todos" (primeira da lista) que funciona como reset:
 * marcá-la limpa a seleção (equivale a "sem filtro"); marcar qualquer
 * opção específica desmarca "Todas" automaticamente (e vice-versa, marcar
 * "Todas" desmarca as específicas). Mesmo padrão visual/de interação do
 * antigo StatusAssociadoFilter (botão com borda + painel flutuante em
 * `surface-elevated`, fecha ao clicar fora) — usado agora pelos filtros
 * "Situação da cobrança" e "Faixa de atraso" (AJUSTE 15 — Repaginar
 * filtros da Taxa de Inadimplência), que passaram de seleção única
 * (dropdown `<select>`) pra múltipla combinável.
 *
 * `opcoes`: lista de `{ valor, label }`, SEM a opção "Todas" (a própria
 * opção "Todas" é fixa, controlada por `labelTodas`, e nunca faz parte do
 * array `value`/`onChange`).
 * `value`: array de `valor`es selecionados — array vazio == "Todas".
 * `onChange(novoArray)`.
 *
 * `subGrupo` (opcional — AJUSTE 15, correção pós-entrega: sub-filtro
 * "Vencidas e confirmadas"/"Só vencidas"/"Só confirmadas" dentro de "Em
 * aberto", trazendo de volta a granularidade do antigo "Tipo de
 * pendência"): `{ paraValor, opcoes, value, onChange }`. Quando a opção
 * cujo `valor === paraValor` estiver marcada, renderiza logo abaixo dela
 * — indentado, dentro do mesmo painel — um grupo de RADIO (escolha única,
 * diferente do checkbox das opções principais) com `opcoes`/`value`/
 * `onChange` próprios. Some junto quando essa opção é desmarcada (não
 * existe estado "meio aberto"). Ignorado quando não passado — as demais
 * instâncias deste componente (ex.: "Faixa de atraso") continuam sem
 * nenhum sub-grupo.
 */
export default function MultiCheckboxFilter({ label, labelTodas = "Todas", opcoes, value, onChange, subGrupo }) {
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

  const selecionados = Array.isArray(value) ? value : [];
  const nenhumaEspecificaSelecionada = selecionados.length === 0;

  function selecionarTodas() {
    onChange([]);
  }

  function alternarOpcao(valor) {
    if (selecionados.includes(valor)) {
      onChange(selecionados.filter((v) => v !== valor));
    } else {
      onChange([...selecionados, valor]);
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setAberto((prev) => !prev)}
        className="flex w-full items-center justify-between gap-2 rounded-xl border border-border-soft bg-surface px-3.5 py-2.5 text-left text-sm text-foreground transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
      >
        {nenhumaEspecificaSelecionada ? (
          <span className="text-muted/60">{labelTodas}</span>
        ) : (
          <span className="truncate rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold text-primary">
            {selecionados.length === 1
              ? opcoes.find((o) => o.valor === selecionados[0])?.label ?? selecionados[0]
              : `${selecionados.length} selecionadas`}
          </span>
        )}
        <IconChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${aberto ? "rotate-180" : ""}`}
        />
      </button>

      {aberto && (
        <div className="absolute z-40 mt-2 w-64 rounded-2xl border border-border-soft bg-surface-elevated p-2 shadow-2xl shadow-black/50">
          {label && (
            <p className="px-2.5 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {label}
            </p>
          )}
          <button
            type="button"
            onClick={selecionarTodas}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-surface-hover"
          >
            <span
              className={`flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-md border transition-colors ${
                nenhumaEspecificaSelecionada ? "border-primary bg-primary text-primary-foreground" : "border-border-soft"
              }`}
            >
              {nenhumaEspecificaSelecionada && <IconCheck className="h-3 w-3" />}
            </span>
            {labelTodas}
          </button>

          <div className="my-1.5 border-t border-border-soft" />

          {opcoes.map((o) => {
            const checked = selecionados.includes(o.valor);
            const mostrarSubGrupo = subGrupo && subGrupo.paraValor === o.valor && checked;
            return (
              <div key={o.valor}>
                <button
                  type="button"
                  onClick={() => alternarOpcao(o.valor)}
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

                {mostrarSubGrupo && (
                  <div className="ml-6 mt-0.5 mb-1 space-y-0.5 border-l border-border-soft pl-3">
                    {subGrupo.opcoes.map((so) => {
                      const selecionado = (subGrupo.value ?? subGrupo.opcoes[0]?.valor) === so.valor;
                      return (
                        <button
                          key={so.valor}
                          type="button"
                          onClick={() => subGrupo.onChange(so.valor)}
                          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
                        >
                          <span
                            className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors ${
                              selecionado ? "border-primary bg-primary" : "border-border-soft"
                            }`}
                          >
                            {selecionado && <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />}
                          </span>
                          {so.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
