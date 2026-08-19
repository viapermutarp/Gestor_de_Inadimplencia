// Lógica do indicador "sem contato recente", derivada de
// `observacao_atualizada_em` (data/hora da última mudança de valor da
// observação, ver PATCH .../negociacao no backend).

const MS_POR_DIA = 24 * 60 * 60 * 1000;
export const LIMITE_DIAS_SEM_CONTATO = 5;

/** Dias corridos desde `observacaoAtualizadaEm` até agora, ou null se não houver data. */
export function getDiasSemContato(observacaoAtualizadaEm) {
  if (!observacaoAtualizadaEm) return null;
  const data = new Date(observacaoAtualizadaEm);
  if (Number.isNaN(data.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - data.getTime()) / MS_POR_DIA));
}

/**
 * Indicador "sem contato recente": só faz sentido para quem está em
 * negociação. Aparece quando `observacao_atualizada_em` é nulo (nunca
 * registrou observação) ou tem mais de `LIMITE_DIAS_SEM_CONTATO` dias.
 * Retorna `null` quando o indicador não deve aparecer, ou
 * `{ dias, tooltip }` quando deve.
 */
export function getIndicadorSemContato(associado) {
  if (!associado?.em_negociacao) return null;

  const dias = getDiasSemContato(associado.observacao_atualizada_em);

  if (dias === null) {
    return { dias: null, tooltip: "Sem contato registrado — nenhuma observação salva" };
  }

  if (dias <= LIMITE_DIAS_SEM_CONTATO) return null;

  return { dias, tooltip: `Sem contato há ${dias}d` };
}

/** Texto legível para o modal de detalhe, ex.: "Última observação: há 3 dias". */
export function formatUltimaObservacao(observacaoAtualizadaEm) {
  const dias = getDiasSemContato(observacaoAtualizadaEm);
  if (dias === null) return "Nenhuma observação registrada ainda";
  if (dias === 0) return "Última observação: hoje";
  if (dias === 1) return "Última observação: há 1 dia";
  return `Última observação: há ${dias} dias`;
}
