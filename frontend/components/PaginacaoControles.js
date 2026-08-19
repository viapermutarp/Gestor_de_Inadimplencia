"use client";

import { IconChevronLeft, IconChevronRight } from "@/components/icons";

/**
 * Controles de paginação abaixo da tabela: anterior/próxima página,
 * indicador "Página X de Y" e total de registros. `paginacao` é o objeto
 * retornado pela API em `GET /api/associados` (paginacao: { pagina_atual,
 * total_paginas, total_registros, por_pagina }).
 */
export default function PaginacaoControles({ paginacao, onChangePage, disabled }) {
  const { pagina_atual: paginaAtual, total_paginas: totalPaginas, total_registros: totalRegistros } =
    paginacao;

  const podeVoltar = !disabled && paginaAtual > 1;
  const podeAvancar = !disabled && paginaAtual < totalPaginas;

  return (
    <div className="flex flex-col gap-3 border-t border-border-soft px-5 py-3.5 text-sm sm:flex-row sm:items-center sm:justify-between">
      <p className="font-mono text-xs text-muted-foreground">
        {totalRegistros === 0
          ? "Nenhum registro"
          : `${totalRegistros} registro${totalRegistros === 1 ? "" : "s"} no total`}
      </p>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => onChangePage(paginaAtual - 1)}
          disabled={!podeVoltar}
          className="flex items-center gap-1 rounded-lg border border-border-soft px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border-soft disabled:hover:text-muted-foreground"
        >
          <IconChevronLeft className="h-3.5 w-3.5" />
          Anterior
        </button>
        <span className="whitespace-nowrap font-mono text-xs font-medium text-foreground">
          Página {paginaAtual} de {totalPaginas}
        </span>
        <button
          type="button"
          onClick={() => onChangePage(paginaAtual + 1)}
          disabled={!podeAvancar}
          className="flex items-center gap-1 rounded-lg border border-border-soft px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border-soft disabled:hover:text-muted-foreground"
        >
          Próxima
          <IconChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
