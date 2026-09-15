"use client";

import { formatCurrency } from "@/lib/format";
import { IconAlert } from "@/components/icons";

/**
 * AJUSTE 17 — item 3 do brief ("Se aproximando do Jurídico"): mesmo estilo
 * visual de `TopDevedores.js` (lista com nome, CPF/CNPJ, valor, barra
 * horizontal proporcional) — pedido explícito do brief, pra não introduzir
 * um padrão visual novo na tela. Diferenças de conteúdo:
 *
 *   - A ORDEM é por `dias_atraso` (maior primeiro — quem está mais perto de
 *     virar Crítico), não por `valor` como em TopDevedores. A barra
 *     continua proporcional ao VALOR (mesma leitura visual "quanto"), mas
 *     quem decide a posição na lista é o atraso, exibido como um badge
 *     próprio em cada linha (ex. "42 dias") — sem esse número visível, o
 *     objetivo do card (progressão em direção ao Jurídico) ficaria
 *     escondido atrás de uma lista que parece só mais um ranking por valor.
 *   - Sem corte de "top 10": a janela de 35-49 dias já limita naturalmente
 *     o tamanho da lista (ver backend), e truncar esconderia justamente
 *     quem o card existe pra mostrar.
 *
 * `resumo.aproximando_juridico` vem pronto do backend (nome, cpf_cnpj,
 * valor — soma só das cobranças na janela de 35-49 dias, não a dívida total
 * do devedor —, dias_atraso — o maior entre as cobranças que qualificaram
 * esse devedor), já ordenado. Nenhum cálculo de atraso/ordenação acontece
 * aqui — só apresentação, mesmo espírito de `TopDevedores`.
 */
export default function AproximandoJuridico({ devedores, loading }) {
  const lista = Array.isArray(devedores) ? devedores : [];
  const valorMaximo = Math.max(...lista.map((d) => Number(d.valor) || 0), 0);

  return (
    <div className="rounded-2xl border border-status-orange/25 bg-status-orange/5 p-5 shadow-lg shadow-black/20">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-status-orange/15 text-status-orange">
          <IconAlert className="h-4.5 w-4.5" />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-foreground">Se aproximando do Jurídico</h3>
          <p className="text-[11px] text-muted-foreground">
            Entre 35 e 49 dias de atraso — quem está mais perto de virar Crítico primeiro, pra agir antes.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="mt-5 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-8 animate-pulse rounded-lg bg-surface-elevated" />
          ))}
        </div>
      ) : lista.length === 0 ? (
        <p className="mt-5 text-center text-sm text-muted-foreground">
          Ninguém no período selecionado está entre 35 e 49 dias de atraso.
        </p>
      ) : (
        <ul className="mt-5 space-y-3">
          {lista.map((devedor, i) => {
            const valor = Number(devedor.valor) || 0;
            const diasAtraso = Number(devedor.dias_atraso) || 0;
            const largura = valorMaximo > 0 ? Math.max((valor / valorMaximo) * 100, 4) : 4;

            return (
              <li key={`${devedor.cpf_cnpj}-${i}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-sm font-medium text-foreground" title={devedor.nome}>
                    {devedor.nome || devedor.cpf_cnpj}
                  </span>
                  <span className="flex shrink-0 items-baseline gap-2">
                    <span className="rounded-full bg-status-orange/15 px-2 py-0.5 font-mono text-[11px] font-semibold text-status-orange">
                      {diasAtraso} {diasAtraso === 1 ? "dia" : "dias"}
                    </span>
                    <span className="font-mono text-xs text-foreground">{formatCurrency(valor)}</span>
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <div className="h-2 w-full overflow-hidden rounded-full bg-surface-elevated">
                    <div className="h-full rounded-full bg-status-orange" style={{ width: `${largura}%` }} />
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
