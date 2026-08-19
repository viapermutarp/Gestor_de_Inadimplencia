"use client";

import { formatCurrency } from "@/lib/format";
import { IconUsers } from "@/components/icons";

/**
 * Lista dos 10 maiores devedores (pagamentos OVERDUE do período), como
 * barras horizontais — mais legível que um gráfico de barras verticais para
 * nomes de empresa, que podem ser longos. A barra usa a cor de marca (não
 * uma cor semântica de atraso): aqui o que importa é o ranking por valor,
 * não o código de risco por faixa (esse já é o papel do FaixasChart).
 */
export default function TopDevedores({ devedores, loading }) {
  const lista = Array.isArray(devedores) ? devedores : [];
  const valorMaximo = Math.max(...lista.map((d) => Number(d.valor) || 0), 0);

  return (
    <div className="rounded-2xl border border-border-soft bg-surface p-5 shadow-lg shadow-black/20">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
          <IconUsers className="h-4.5 w-4.5" />
        </span>
        <h3 className="text-sm font-semibold text-foreground">Top 10 devedores</h3>
      </div>

      {loading ? (
        <div className="mt-5 space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-8 animate-pulse rounded-lg bg-surface-elevated" />
          ))}
        </div>
      ) : lista.length === 0 ? (
        <p className="mt-5 text-center text-sm text-muted-foreground">
          Nenhum devedor em atraso no período selecionado.
        </p>
      ) : (
        <ul className="mt-5 space-y-3">
          {lista.map((devedor, i) => {
            const valor = Number(devedor.valor) || 0;
            const largura = valorMaximo > 0 ? Math.max((valor / valorMaximo) * 100, 4) : 4;

            return (
              <li key={`${devedor.cpf_cnpj}-${i}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-sm font-medium text-foreground" title={devedor.nome}>
                    {i + 1}. {devedor.nome || devedor.cpf_cnpj}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-foreground">{formatCurrency(valor)}</span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <div className="h-2 w-full overflow-hidden rounded-full bg-surface-elevated">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${largura}%` }} />
                  </div>
                </div>
                <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{devedor.cpf_cnpj}</p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
