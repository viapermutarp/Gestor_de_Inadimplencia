"use client";

/**
 * Ponto amarelo sutil indicando "sem contato recente" — só deve ser
 * renderizado quando `getIndicadorSemContato` (lib/contato.js) retorna um
 * indicador. Usa a cor semântica `status-yellow` (mesma dos badges de
 * atraso "Atenção"), com um halo suave para chamar atenção sem poluir a
 * tabela. Tooltip nativo via `title`.
 */
export default function SemContatoIndicador({ tooltip }) {
  return (
    <span
      title={tooltip}
      aria-label={tooltip}
      role="img"
      className="inline-block h-2 w-2 shrink-0 rounded-full bg-status-yellow ring-4 ring-status-yellow/20"
    />
  );
}
