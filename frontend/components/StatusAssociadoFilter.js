"use client";

import { useEffect, useRef, useState } from "react";
import { IconCheck, IconChevronDown } from "@/components/icons";

// "Tipo de inadimplente" (AJUSTE 15 — Repaginar filtros da Taxa de
// Inadimplência, item 6 do brief) — expande o antigo tri-state exclusivo
// de "Jurídico" (reunião Suelen + Roberto, 08/09: "todos"|"ativos"|
// "juridico") pra 3 categorias COMBINÁVEIS por checkbox, mapeadas pro
// parâmetro `tipo_inadimplente` do backend (array -> string separada por
// vírgula, ver lib/api.js): "ativo" (em_juridico=false), "juridico"
// (em_juridico=true) e "critico" (associado com pelo menos 1 cobrança com
// 90+ dias de atraso, respeitando a "visao" selecionada — mesmo critério
// de `criticos_90_dias`). Diferente do tri-state anterior, um associado
// jurídico com dívida de 100 dias aparece em "Jurídico" E "Crítico" ao
// mesmo tempo quando os dois estão marcados — o backend garante que isso
// não duplica o valor dele na soma (união por CPF/CNPJ, não soma por
// combinação — ver README do backend, seção "AJUSTE 15").
const OPCOES_TIPO_INADIMPLENTE = [
  { valor: "ativo", label: "Ativo/Recuperável" },
  { valor: "juridico", label: "Jurídico" },
  { valor: "critico", label: "Crítico (90+ dias)" },
];

/**
 * Filtro "Tipo de inadimplente". `value` é um objeto
 * `{ emNegociacao, bloqueado, tipoInadimplente }` — "tipoInadimplente" é
 * um array de "ativo"|"juridico"|"critico" (vazio = sem filtro = "Todos"),
 * mapeado pro parâmetro `tipo_inadimplente` da API (ver lib/api.js),
 * combinado por OU (união) — ver docblock de OPCOES_TIPO_INADIMPLENTE
 * acima.
 *
 * **"emNegociacao"/"bloqueado" saíram da UI** (correção pós-entrega do
 * AJUSTE 15, mesmo padrão já usado antes com "Tipo de pendência" — ver
 * README do frontend): os 2 checkboxes "Em negociação"/"Bloqueado" que
 * ficavam aqui em cima do "Tipo de inadimplente" foram removidos da tela.
 * O parâmetro do backend (`renegociacao`/`bloqueado` em
 * `getResumoInadimplencia`/`getEvolucaoMensal`) continua intacto — este
 * componente só parou de oferecer uma forma de marcá-los como "sim"; o
 * objeto `value` ainda carrega `emNegociacao`/`bloqueado` (sempre `false`
 * agora, já que não há mais UI pra ligá-los) só pra não quebrar o shape
 * que `app/inadimplencia/page.js` já espera — se algum dia isso precisar
 * voltar, é só reintroduzir os 2 botões removidos aqui.
 *
 * Mesmo padrão visual do DatePicker/MultiCheckboxFilter (botão com borda +
 * painel flutuante em `surface-elevated`, fecha ao clicar fora) para não
 * introduzir um novo estilo de dropdown na tela.
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

  const tipoInadimplente = Array.isArray(value?.tipoInadimplente) ? value.tipoInadimplente : [];
  const quantidadeAtiva = tipoInadimplente.length;

  function selecionarTodosTipos() {
    onChange({ ...value, tipoInadimplente: [] });
  }

  function alternarTipoInadimplente(valor) {
    const atual = Array.isArray(value?.tipoInadimplente) ? value.tipoInadimplente : [];
    const novo = atual.includes(valor) ? atual.filter((v) => v !== valor) : [...atual, valor];
    onChange({ ...value, tipoInadimplente: novo });
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
          <button
            type="button"
            onClick={selecionarTodosTipos}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-surface-hover"
          >
            <span
              className={`flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-md border transition-colors ${
                tipoInadimplente.length === 0 ? "border-primary bg-primary text-primary-foreground" : "border-border-soft"
              }`}
            >
              {tipoInadimplente.length === 0 && <IconCheck className="h-3 w-3" />}
            </span>
            Todos
          </button>

          {OPCOES_TIPO_INADIMPLENTE.map((o) => {
            const checked = tipoInadimplente.includes(o.valor);
            return (
              <button
                key={o.valor}
                type="button"
                onClick={() => alternarTipoInadimplente(o.valor)}
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
