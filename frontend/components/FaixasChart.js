"use client";

import { formatCurrency } from "@/lib/format";

const compactCurrencyFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  notation: "compact",
  maximumFractionDigits: 1,
});

/**
 * As 7 faixas, na ordem de exibição, com a cor de cada uma — AJUSTE 5:
 * ganhou a faixa "ate_vencimento" (cobranças ainda dentro do vencimento ou
 * da tolerância, que antes não apareciam em nenhuma faixa) e a antiga
 * "100_180" foi renomeada pra "acima_100" (mesmo comportamento sem teto de
 * sempre, só corrigindo o nome). As cores são interpoladas entre as 4 cores
 * semânticas de atraso já usadas no resto do app (azul/neutro → verde →
 * amarelo → laranja → vermelho — ver lib/atraso.js), criando uma rampa de
 * calor com 7 degraus sem introduzir nenhuma cor de marca nova. "Até o
 * vencimento" é a mais fria/neutra (nem chegou a atrasar); faixa mais
 * crítica = mais quente/vermelha.
 */
const FAIXAS = [
  { chave: "ate_vencimento", label: "Até o vencimento", cor: "#38bdf8" },
  { chave: "1_20", label: "1-20d", cor: "#22c55e" },
  { chave: "21_30", label: "21-30d", cor: "#a1ba26" },
  { chave: "31_40", label: "31-40d", cor: "#f6a808" },
  { chave: "41_50", label: "41-50d", cor: "#fa851d" },
  { chave: "51_100", label: "51-100d", cor: "#f76534" },
  { chave: "acima_100", label: "100d+", cor: "#f2454b" },
];

const ALTURA_MAXIMA_PX = 160;
const ALTURA_MINIMA_PX = 4;

function formatPercentual(valor, total) {
  if (!(total > 0)) return "—";
  return `${((valor / total) * 100).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

/**
 * Gráfico de barras das 7 faixas de atraso (valor em R$ em cada uma, mais o
 * percentual que representa sobre o total inadimplente do período).
 * `faixaSelecionada` (chave da faixa, ou "todas") controla o destaque: a
 * faixa escolhida no filtro fica em opacidade cheia, as demais ficam
 * esmaecidas — dá uma resposta visual imediata ao filtro "Faixa de atraso",
 * já que a API não filtra o próprio cálculo por faixa (ela sempre retorna
 * as 7 somas do período inteiro).
 *
 * `visao` ("aberto" | "historico") reflete o parâmetro `visao` do backend
 * (renomeado de `visao_faixas` — AJUSTE 6: agora controla, além destas
 * faixas, também os 3 cards do topo da tela — ver ResumoInadimplenciaCards),
 * escolhido pelas abas no cabeçalho deste card — trocar a aba chama
 * `onAlterarVisao`, que a página usa para refazer a chamada a
 * GET /api/inadimplencia/resumo com o novo valor. "aberto" (padrão) é o
 * snapshot de hoje (só quem ainda não pagou); "historico" inclui quem
 * pagou com atraso no período, mesmo já com status atual de pago — ver
 * README do backend, seção "Faixas de atraso: modo aberto x histórico".
 *
 * Estrutura: o rótulo (valor + %) e o texto da faixa ficam em linhas
 * PRÓPRIAS, fora da área de barra (`ALTURA_MAXIMA_PX`, altura fixa) — antes,
 * rótulo + barra + legenda dividiam o mesmo container de altura fixa via
 * `items-end`, e uma barra no máximo (160px) somada à altura do rótulo
 * estourava o container por cima, sobrepondo o texto/título acima do
 * gráfico. Com o rótulo em fluxo normal acima de uma área de barra de
 * altura fixa (nunca comprimida pelo próprio rótulo), a barra nunca invade
 * o espaço do texto, em nenhuma largura de tela.
 */
export default function FaixasChart({
  faixas,
  faixaSelecionada = "todas",
  onSelecionarFaixa,
  loading,
  totalInadimplente,
  visao = "aberto",
  onAlterarVisao,
}) {
  const valores = FAIXAS.map((f) => Number(faixas?.[f.chave] ?? 0));
  const valorMaximo = Math.max(...valores, 0);
  const total = totalInadimplente ?? valores.reduce((soma, v) => soma + v, 0);

  return (
    <div className="rounded-2xl border border-border-soft bg-surface p-5 shadow-lg shadow-black/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Valor em atraso por faixa</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {visao === "historico"
              ? "Histórico do período: inclui quem venceu no período e não pagou em dia — mesmo quem já pagou (com atraso). Também é o critério usado nos cards de Valor Inadimplente/Adimplente/Taxa acima."
              : "Em aberto hoje: só dívida ainda não paga neste momento — mesmo critério usado nos cards acima."}
          </p>
        </div>

        <div className="flex shrink-0 rounded-xl border border-border-soft bg-surface-elevated p-1 text-xs font-medium">
          <button
            type="button"
            onClick={() => onAlterarVisao?.("aberto")}
            className={`rounded-lg px-3 py-1.5 transition-colors ${
              visao === "aberto" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Em aberto hoje
          </button>
          <button
            type="button"
            onClick={() => onAlterarVisao?.("historico")}
            className={`rounded-lg px-3 py-1.5 transition-colors ${
              visao === "historico" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Histórico do período
          </button>
        </div>
      </div>

      {loading ? (
        <div className="mt-6 flex items-end gap-3">
          {FAIXAS.map((f) => (
            <div key={f.chave} className="flex-1 animate-pulse rounded-t-lg bg-surface-elevated" style={{ height: `${ALTURA_MAXIMA_PX * 0.6}px` }} />
          ))}
        </div>
      ) : (
        <div className="mt-6 flex items-end gap-2 sm:gap-3">
          {FAIXAS.map((f, i) => {
            const valor = valores[i];
            const alturaPx =
              valorMaximo > 0 ? Math.max((valor / valorMaximo) * ALTURA_MAXIMA_PX, ALTURA_MINIMA_PX) : ALTURA_MINIMA_PX;
            const destacada = faixaSelecionada === "todas" || faixaSelecionada === f.chave;

            return (
              <button
                key={f.chave}
                type="button"
                onClick={() => onSelecionarFaixa?.(faixaSelecionada === f.chave ? "todas" : f.chave)}
                className="flex flex-1 flex-col items-center rounded-lg transition-opacity"
                style={{ opacity: destacada ? 1 : 0.35 }}
                title={`${formatCurrency(valor)} (${formatPercentual(valor, total)} do total inadimplente)`}
              >
                {/* Rótulo — em fluxo normal, nunca disputa espaço com a barra */}
                <span className="flex flex-col items-center leading-tight">
                  <span className="font-mono text-[11px] text-foreground">
                    {compactCurrencyFormatter.format(valor)}
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">{formatPercentual(valor, total)}</span>
                </span>

                {/* Área da barra — altura fixa, isolada do rótulo acima e da legenda abaixo */}
                <span className="mt-1.5 flex w-full items-end justify-center" style={{ height: `${ALTURA_MAXIMA_PX}px` }}>
                  <span
                    className="w-full rounded-t-lg transition-all"
                    style={{ height: `${alturaPx}px`, backgroundColor: f.cor }}
                  />
                </span>

                <span className="mt-1.5 text-[11px] text-muted-foreground">{f.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
