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
  IconPercent,
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

/**
 * Card "em destaque" — os 3 números centrais da tela (AJUSTE 16: Total
 * Faturado / Total em Aberto / Total Recebido), lado a lado, mesmo peso
 * visual entre si. Substitui os 2 cards "hero" gigantes de antes (Taxa de
 * Inadimplência + Valor adimplente) — a taxa desceu pra linha de cards
 * menores (ver CardSecundario abaixo), porque este destaque agora é sobre
 * DINHEIRO (3 valores em R$ que somados/comparados contam a história do
 * caixa), não sobre a taxa percentual isolada.
 */
function CardDestaque({ label, valor, badge, Icon, tom = "neutro", loading }) {
  const cores = {
    neutro: { borda: "border-border-soft", fundo: "bg-surface", chip: "bg-primary/15 text-primary", texto: "text-foreground" },
    aberto: {
      borda: "border-status-orange/25",
      fundo: "bg-status-orange/5",
      chip: "bg-status-orange/15 text-status-orange",
      texto: "text-status-orange",
    },
    recebido: {
      borda: "border-status-green/25",
      fundo: "bg-status-green/5",
      chip: "bg-status-green/15 text-status-green",
      texto: "text-status-green",
    },
  }[tom];

  return (
    <div className={`flex flex-col justify-center rounded-2xl border ${cores.borda} ${cores.fundo} p-5 shadow-lg shadow-black/20`}>
      <span className={`flex h-9 w-9 items-center justify-center rounded-full ${cores.chip}`}>
        <Icon className="h-4.5 w-4.5" />
      </span>

      {loading ? (
        <div className="mt-3 h-9 w-32 animate-pulse rounded-md bg-surface-elevated sm:h-10 sm:w-40" />
      ) : (
        <p className={`mt-2 truncate font-display text-3xl font-bold tabular-nums sm:text-4xl ${cores.texto}`} title={String(valor)}>
          {valor}
        </p>
      )}

      <p className="mt-1.5 text-xs font-normal uppercase tracking-wide text-muted-foreground">{label}</p>
      {badge && <p className="mt-0.5 text-[11px] text-muted-foreground/70">{badge}</p>}
    </div>
  );
}

/**
 * Card secundário (menor) — usado nas 2 linhas de baixo (3 + 2 cards, AJUSTE
 * 16): Taxa de Inadimplência / Taxa de Adimplência / Associados
 * Inadimplentes, depois Renegociações Abertas / Críticos 90+ dias. `corTexto`
 * (opcional) colore o número em destaque — usado pelas 2 taxas, que antes
 * tinham essa cor só na versão "hero" gigante e mantêm o mesmo significado
 * semântico agora em tamanho menor.
 */
function CardSecundario({ label, valor, subtitulo, Icon, loading, corTexto, corChip }) {
  return (
    <div className="rounded-2xl border border-border-soft bg-surface p-3.5 shadow-lg shadow-black/20">
      <span className={`flex h-7 w-7 items-center justify-center rounded-full ${corChip || "bg-primary/15 text-primary"}`}>
        <Icon className="h-3.5 w-3.5" />
      </span>

      {loading ? (
        <div className="mt-2.5 h-6 w-16 animate-pulse rounded-md bg-surface-elevated" />
      ) : (
        <p
          className={`mt-2.5 truncate font-display text-xl font-bold tabular-nums ${corTexto || "text-foreground"}`}
          title={String(valor)}
        >
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
 * o objeto de GET /api/inadimplencia/resumo.
 *
 * AJUSTE 16 — Reorganizar cards da Taxa de Inadimplência (brief). Trocou a
 * estrutura antiga (2 cards "hero" gigantes + 5 cards pequenos numa única
 * linha) por 3 linhas, 8 cards no total:
 *
 *   1. Em destaque (3, `CardDestaque`, mesmo peso visual entre si) — Total
 *      Faturado (`valor_total_faturado`, sem mudança), Total em Aberto
 *      (NOVO — `valor_total_aberto`: soma de tudo que ainda não entrou no
 *      caixa, OVERDUE+CONFIRMED+PENDING juntos, SEM toggle e SEM depender
 *      de vencimento — diferente de "Valor inadimplente", que não vira mais
 *      card nesta tela, só existia como um dos 5 pequenos antes; o dado
 *      continua vindo da API, só parou de ser exibido separadamente, já que
 *      "Total em Aberto" cobre a mesma necessidade de forma mais direta) e
 *      Total Recebido (renomeado de "Valor adimplente" — mesmo campo
 *      `valor_adimplente`, mesmo cálculo/toggle de sempre, só virou card
 *      próprio em vez de aparecer como hero verde solitário).
 *   2. Cards menores (3, `CardSecundario`, mesmo tamanho de sempre) — Taxa
 *      de Inadimplência (desceu do hero pra cá, cálculo intacto, mesma
 *      rampa de cor de `corDaTaxa`), Taxa de Adimplência (NOVO como CARD —
 *      o campo `taxa_adimplencia_percentual` já existia na API desde antes
 *      deste ajuste, só não tinha card próprio, aparecia só como legenda
 *      pequena embaixo do hero verde) e Associados Inadimplentes (sem
 *      mudança).
 *   3. Linha extra (2, `CardSecundario`) — Renegociações Abertas e Críticos
 *      90+ dias, sem mudança de cálculo, só reposicionados pra cá.
 *
 * `visao` ("aberto" | "historico", AJUSTE 6) continua controlando "Total
 * Recebido"/"Taxa de Inadimplência"/"Taxa de Adimplência" (mesmo critério de
 * sempre); "Total Faturado" e "Total em Aberto" NÃO seguem esse toggle (ver
 * docblock de `valor_total_aberto` no backend) — por isso só os 3 primeiros
 * cards abaixo recebem o selo `rotuloVisao`.
 */
export default function ResumoInadimplenciaCards({ resumo, loading, visao = "aberto" }) {
  const rotuloVisao = visao === "historico" ? "Histórico do período" : "Em aberto hoje";
  const taxaInadimplencia = resumo?.taxa_inadimplencia_percentual ?? 0;
  const taxaAdimplencia = resumo?.taxa_adimplencia_percentual ?? 0;
  const coresTaxaInadimplencia = corDaTaxa(taxaInadimplencia);

  function formatarTaxa(taxa) {
    return `${taxa.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  }

  const cardsMenores = [
    {
      label: "Taxa de inadimplência",
      valor: formatarTaxa(taxaInadimplencia),
      subtitulo: rotuloVisao,
      Icon: IconTrendingUp,
      corTexto: coresTaxaInadimplencia.texto,
      corChip: coresTaxaInadimplencia.chip,
    },
    {
      label: "Taxa de adimplência",
      valor: formatarTaxa(taxaAdimplencia),
      subtitulo: rotuloVisao,
      Icon: IconPercent,
      corTexto: "text-status-green",
      corChip: "bg-status-green/15 text-status-green",
    },
    {
      label: "Associados inadimplentes",
      valor: resumo?.associados_inadimplentes ?? 0,
      Icon: IconUsers,
    },
  ];

  const cardsExtras = [
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
      {/* Linha 1 — 3 cards em destaque (dinheiro) */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <CardDestaque label="Total faturado" valor={formatCurrency(resumo?.valor_total_faturado ?? 0)} Icon={IconReceipt} tom="neutro" loading={loading} />
        <CardDestaque
          label="Total em aberto"
          valor={formatCurrency(resumo?.valor_total_aberto ?? 0)}
          Icon={IconBanknote}
          tom="aberto"
          loading={loading}
        />
        <CardDestaque
          label="Total recebido"
          valor={formatCurrency(resumo?.valor_adimplente ?? 0)}
          badge={rotuloVisao}
          Icon={IconCheckCircle}
          tom="recebido"
          loading={loading}
        />
      </div>

      {/* Linha 2 — 3 cards menores (taxas + contagem) */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {cardsMenores.map((card) => (
          <CardSecundario key={card.label} {...card} loading={loading} />
        ))}
      </div>

      {/* Linha 3 — 2 cards extras (renegociações + críticos) */}
      <div className="grid grid-cols-2 gap-3">
        {cardsExtras.map((card) => (
          <CardSecundario key={card.label} {...card} loading={loading} />
        ))}
      </div>
    </div>
  );
}
