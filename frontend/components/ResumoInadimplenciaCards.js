"use client";

import { formatCurrency } from "@/lib/format";
import {
  IconReceipt,
  IconBanknote,
  IconUsers,
  IconChatBubble,
  IconAlert,
  IconTrendingUp,
  IconCheckCircle,
} from "@/components/icons";

/**
 * Faixas de cor para a taxa de inadimplência (%) — decisão de design não
 * ditada pelo backend, feita para dar leitura visual imediata ao número em
 * destaque, reaproveitando a mesma paleta semântica fixa de atraso já usada
 * no dashboard (nunca introduz uma cor de marca nova).
 */
function corDaTaxa(taxa) {
  if (taxa >= 30) return { texto: "text-status-red", chip: "bg-status-red/15 text-status-red" };
  if (taxa >= 15) return { texto: "text-status-orange", chip: "bg-status-orange/15 text-status-orange" };
  if (taxa >= 5) return { texto: "text-status-yellow", chip: "bg-status-yellow/15 text-status-yellow" };
  return { texto: "text-status-green", chip: "bg-status-green/15 text-status-green" };
}

function CardSecundario({ label, valor, subtitulo, Icon, loading }) {
  return (
    <div className="rounded-2xl border border-border-soft bg-surface p-3.5 shadow-lg shadow-black/20">
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-primary">
        <Icon className="h-3.5 w-3.5" />
      </span>

      {loading ? (
        <div className="mt-2.5 h-6 w-16 animate-pulse rounded-md bg-surface-elevated" />
      ) : (
        <p className="mt-2.5 truncate font-display text-xl font-bold tabular-nums text-foreground" title={String(valor)}>
          {valor}
        </p>
      )}
      {subtitulo && !loading && (
        <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{subtitulo}</p>
      )}
      <p className="mt-1 text-xs font-normal uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}

/**
 * Cards de resumo da tela de Taxa de Inadimplência, consumindo diretamente
 * o objeto de GET /api/inadimplencia/resumo. A taxa de inadimplência e o
 * valor adimplente recebem destaque visual maior que os demais números
 * (dois cards "hero" lado a lado na primeira linha, fonte bem maior) —
 * são os dois números mais importantes da tela, um espelhando o outro
 * (vermelho = risco, verde = saúde da carteira).
 */
export default function ResumoInadimplenciaCards({ resumo, loading }) {
  const taxa = resumo?.taxa_inadimplencia_percentual ?? 0;
  const cores = corDaTaxa(taxa);
  const taxaAdimplencia = resumo?.taxa_adimplencia_percentual ?? 0;

  const cards = [
    {
      label: "Valor total faturado",
      valor: formatCurrency(resumo?.valor_total_faturado ?? 0),
      Icon: IconReceipt,
    },
    {
      label: "Valor inadimplente",
      valor: formatCurrency(resumo?.valor_inadimplente ?? 0),
      Icon: IconBanknote,
    },
    {
      label: "Associados inadimplentes",
      valor: resumo?.associados_inadimplentes ?? 0,
      Icon: IconUsers,
    },
    {
      label: "Renegociações abertas",
      valor: resumo?.renegociacoes_abertas?.quantidade ?? 0,
      subtitulo: formatCurrency(resumo?.renegociacoes_abertas?.valor ?? 0),
      Icon: IconChatBubble,
    },
    {
      label: "Críticos 90+ dias",
      valor: formatCurrency(resumo?.criticos_90_dias ?? 0),
      Icon: IconAlert,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* Taxa de inadimplência — card hero vermelho/semântico */}
        <div className="flex flex-col justify-center rounded-2xl border border-border-soft bg-surface p-5 shadow-lg shadow-black/20">
          <span className={`flex h-9 w-9 items-center justify-center rounded-full ${cores.chip}`}>
            <IconTrendingUp className="h-4.5 w-4.5" />
          </span>

          {loading ? (
            <div className="mt-3 h-11 w-28 animate-pulse rounded-md bg-surface-elevated" />
          ) : (
            <p className={`mt-2 font-display text-5xl font-bold tabular-nums ${cores.texto}`}>
              {taxa.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              <span className="text-2xl">%</span>
            </p>
          )}
          <p className="mt-1.5 text-xs font-normal uppercase tracking-wide text-muted-foreground">
            Taxa de inadimplência
          </p>
        </div>

        {/* Valor adimplente — card hero verde, o contraponto positivo do
            card de inadimplência ao lado (mesmo tamanho de fonte, cor
            fixa "status-green" em vez da rampa de corDaTaxa). */}
        <div className="flex flex-col justify-center rounded-2xl border border-status-green/25 bg-status-green/5 p-5 shadow-lg shadow-black/20">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-status-green/15 text-status-green">
            <IconCheckCircle className="h-4.5 w-4.5" />
          </span>

          {loading ? (
            <div className="mt-3 h-11 w-40 animate-pulse rounded-md bg-surface-elevated" />
          ) : (
            <p className="mt-2 truncate font-display text-4xl font-bold tabular-nums text-status-green sm:text-5xl">
              {formatCurrency(resumo?.valor_adimplente ?? 0)}
            </p>
          )}
          {!loading && (
            <p className="mt-1 font-mono text-xs text-status-green/80">
              {taxaAdimplencia.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}% do
              faturado
            </p>
          )}
          <p className="mt-1.5 text-xs font-normal uppercase tracking-wide text-muted-foreground">
            Valor adimplente
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map((card) => (
          <CardSecundario key={card.label} {...card} loading={loading} />
        ))}
      </div>
    </div>
  );
}
