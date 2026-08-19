"use client";

import { formatCurrency } from "@/lib/format";
import { IconReceipt, IconBanknote, IconChatBubble, IconLock, IconScale } from "@/components/icons";

/**
 * Cards de resumo do dashboard. Consomem diretamente o objeto agregado de
 * `GET /api/associados/resumo` (calculado no banco) — não dependem do
 * filtro/busca/página ativos na tabela, para funcionar como uma visão geral
 * estável da carteira inteira, com uma única chamada à API.
 *
 * O ícone de cada card usa sempre a cor de marca (Sinal) — as cores
 * semânticas de atraso (verde/âmbar/laranja/vermelho) ficam reservadas
 * só para a tabela, para não diluir esse código de risco.
 */
export default function ResumoCards({ resumo, loading }) {
  const cards = [
    { label: "Com cobrança em aberto", valor: resumo?.com_cobranca_aberto ?? 0, Icon: IconReceipt },
    { label: "Valor total em aberto", valor: formatCurrency(resumo?.valor_total_aberto ?? 0), Icon: IconBanknote },
    { label: "Em negociação", valor: resumo?.em_negociacao ?? 0, Icon: IconChatBubble },
    { label: "Bloqueados", valor: resumo?.bloqueados ?? 0, Icon: IconLock },
    { label: "No jurídico", valor: resumo?.em_juridico ?? 0, Icon: IconScale },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {cards.map(({ label, valor, Icon }) => (
        <div
          key={label}
          className="rounded-2xl border border-border-soft bg-surface p-3.5 shadow-lg shadow-black/20"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-primary">
            <Icon className="h-3.5 w-3.5" />
          </span>

          {loading && !resumo ? (
            <div className="mt-2.5 h-6 w-14 animate-pulse rounded-md bg-surface-elevated" />
          ) : (
            <p
              className="mt-2.5 truncate font-display text-xl font-bold tabular-nums text-foreground"
              title={String(valor)}
            >
              {valor}
            </p>
          )}
          <p className="mt-1 text-xs font-normal uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
        </div>
      ))}
    </div>
  );
}
