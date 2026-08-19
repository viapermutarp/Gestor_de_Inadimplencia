"use client";

import { formatMesAbreviado } from "@/lib/format";
import { IconTrendingUp } from "@/components/icons";

const LARGURA = 680;
const ALTURA = 240;
const PAD_ESQUERDA = 38;
const PAD_DIREITA = 14;
const PAD_TOPO = 14;
const PAD_BASE = 34;

const LARGURA_PLOT = LARGURA - PAD_ESQUERDA - PAD_DIREITA;
const ALTURA_PLOT = ALTURA - PAD_TOPO - PAD_BASE;

const LINHAS_GRADE = [0, 25, 50, 75, 100];

const COR_INADIMPLENCIA = "#f2454b"; // status-red
const COR_ADIMPLENCIA = "#22c55e"; // status-green

function coordenadaX(i, total) {
  if (total <= 1) return PAD_ESQUERDA + LARGURA_PLOT / 2;
  return PAD_ESQUERDA + (i / (total - 1)) * LARGURA_PLOT;
}

function coordenadaY(valorPercentual) {
  const v = Math.min(Math.max(Number(valorPercentual) || 0, 0), 100);
  return PAD_TOPO + (1 - v / 100) * ALTURA_PLOT;
}

function construirPath(dados, campo) {
  return dados
    .map((d, i) => `${i === 0 ? "M" : "L"}${coordenadaX(i, dados.length).toFixed(2)},${coordenadaY(d[campo]).toFixed(2)}`)
    .join(" ");
}

/**
 * Gráfico de linha da evolução mensal da taxa de inadimplência/adimplência
 * (GET /api/inadimplencia/evolucao-mensal), reagindo aos mesmos filtros de
 * vencimento/renegociação/jurídico da página — o componente só recebe os
 * dados já filtrados, quem decide o que buscar é a página. SVG desenhado à
 * mão (sem lib de gráfico), consistente com FaixasChart/TopDevedores.
 *
 * Quando há muitos meses no período, nem todo rótulo do eixo X é exibido
 * (evita sobrepor texto) — mostra no máximo ~8 rótulos, distribuídos.
 */
export default function EvolucaoMensalChart({ dados, loading, erro }) {
  const lista = Array.isArray(dados) ? dados : [];

  const passoRotulo = lista.length > 8 ? Math.ceil(lista.length / 8) : 1;

  return (
    <div className="rounded-2xl border border-border-soft bg-surface p-5 shadow-lg shadow-black/20">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <IconTrendingUp className="h-4.5 w-4.5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Evolução mensal</h3>
            <p className="text-xs text-muted-foreground">Taxa de inadimplência x adimplência, mês a mês.</p>
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: COR_INADIMPLENCIA }} />
            Inadimplência
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: COR_ADIMPLENCIA }} />
            Adimplência
          </span>
        </div>
      </div>

      <div className="mt-4">
        {loading ? (
          <div className="h-[240px] w-full animate-pulse rounded-xl bg-surface-elevated" />
        ) : erro ? (
          <p className="flex h-[240px] items-center justify-center text-center text-sm text-muted-foreground">
            {erro}
          </p>
        ) : lista.length === 0 ? (
          <p className="flex h-[240px] items-center justify-center text-center text-sm text-muted-foreground">
            Sem dados de evolução mensal para o período selecionado.
          </p>
        ) : (
          <svg viewBox={`0 0 ${LARGURA} ${ALTURA}`} className="w-full" role="img" aria-label="Evolução mensal da taxa de inadimplência e adimplência">
            {/* Linhas de grade horizontais + rótulos do eixo Y (0-100%) */}
            {LINHAS_GRADE.map((pct) => {
              const y = coordenadaY(pct);
              return (
                <g key={pct}>
                  <line
                    x1={PAD_ESQUERDA}
                    x2={LARGURA - PAD_DIREITA}
                    y1={y}
                    y2={y}
                    style={{ stroke: "var(--border-soft)" }}
                    strokeWidth="1"
                  />
                  <text x={PAD_ESQUERDA - 8} y={y + 3} textAnchor="end" style={{ fill: "var(--muted-foreground)" }} fontSize="10">
                    {pct}%
                  </text>
                </g>
              );
            })}

            {/* Rótulos do eixo X (meses) */}
            {lista.map((d, i) => {
              if (i % passoRotulo !== 0 && i !== lista.length - 1) return null;
              const x = coordenadaX(i, lista.length);
              return (
                <text
                  key={d.mes}
                  x={x}
                  y={ALTURA - PAD_BASE + 16}
                  textAnchor="middle"
                  style={{ fill: "var(--muted-foreground)" }}
                  fontSize="10"
                >
                  {formatMesAbreviado(d.mes)}
                </text>
              );
            })}

            {/* Série: taxa de adimplência (desenhada antes, fica "atrás") */}
            <path d={construirPath(lista, "taxa_adimplencia_percentual")} fill="none" stroke={COR_ADIMPLENCIA} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            {/* Série: taxa de inadimplência */}
            <path d={construirPath(lista, "taxa_inadimplencia_percentual")} fill="none" stroke={COR_INADIMPLENCIA} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

            {/* Pontos + tooltip nativo (title) em cada mês, para as duas séries */}
            {lista.map((d, i) => {
              const x = coordenadaX(i, lista.length);
              return (
                <g key={d.mes}>
                  <circle cx={x} cy={coordenadaY(d.taxa_adimplencia_percentual)} r="3" fill={COR_ADIMPLENCIA}>
                    <title>
                      {formatMesAbreviado(d.mes)} — Adimplência: {Number(d.taxa_adimplencia_percentual).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%
                    </title>
                  </circle>
                  <circle cx={x} cy={coordenadaY(d.taxa_inadimplencia_percentual)} r="3" fill={COR_INADIMPLENCIA}>
                    <title>
                      {formatMesAbreviado(d.mes)} — Inadimplência: {Number(d.taxa_inadimplencia_percentual).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%
                    </title>
                  </circle>
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
}
