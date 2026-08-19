// Cobranças consideradas "em aberto" para fins de cálculo do dashboard.
export const STATUS_ABERTOS = ["pending", "overdue"];

export function getCobrancasAbertas(associado) {
  return (associado?.cobrancas || []).filter((c) => STATUS_ABERTOS.includes(c.status));
}

/**
 * IMPORTANTE — convenção de sinal do "dias_diferenca" (vem do backend):
 *   - Negativo = a cobrança está em atraso (quanto mais negativo, mais dias em atraso).
 *   - Zero ou positivo = a cobrança está em dia (o valor positivo é quantos dias
 *     faltam até o vencimento).
 *
 * "Pior" cobrança em aberto do associado = a de menor (mais negativo) dias_diferenca,
 * ou seja, a mais atrasada. Retorna null quando não há cobranças em aberto
 * (associado em dia / sem débito).
 */
export function getPiorDiasDiferenca(associado) {
  const abertas = getCobrancasAbertas(associado);
  if (abertas.length === 0) return null;
  return Math.min(...abertas.map((c) => Number(c.dias_diferenca)));
}

/** Soma do valor de todas as cobranças em aberto do associado. */
export function getSomaValorAberto(associado) {
  const abertas = getCobrancasAbertas(associado);
  return abertas.reduce((total, c) => total + Number(c.valor || 0), 0);
}

/**
 * Faixas de atraso (cores semânticas fixas, fora da paleta do tema), a partir
 * do "pior" dias_diferenca em aberto do associado (ver getPiorDiasDiferenca):
 *  - Verde:    em dia — sem cobrança em aberto, ou dias_diferenca >= 0
 *  - Amarelo:  dias_diferenca entre -1 e -9 (1 a 9 dias de atraso)
 *  - Laranja:  dias_diferenca entre -10 e -19 (10 a 19 dias de atraso)
 *  - Vermelho: dias_diferenca <= -20 (20+ dias de atraso)
 */
export function getStatusAtraso(diasDiferenca) {
  if (diasDiferenca === null || diasDiferenca === undefined) {
    return { key: "em_dia", label: "Em dia", color: "green" };
  }

  if (diasDiferenca >= 0) {
    const label = diasDiferenca === 0 ? "Vence hoje" : `Vence em ${diasDiferenca}d`;
    return { key: "em_dia", label, color: "green" };
  }

  const diasAtraso = Math.abs(diasDiferenca);

  if (diasDiferenca >= -9) {
    return { key: "atencao", label: `${diasAtraso}d de atraso`, color: "yellow" };
  }
  if (diasDiferenca >= -19) {
    return { key: "alerta", label: `${diasAtraso}d de atraso`, color: "orange" };
  }
  return { key: "critico", label: `${diasAtraso}d de atraso`, color: "red" };
}

/**
 * Classes de apresentação por faixa de atraso — intensidade crescente com a
 * severidade, para reforçar visualmente a hierarquia de urgência:
 *  - `row`: tingimento de fundo da linha na tabela (verde = neutro, sem
 *    tingimento — não precisa de atenção; vermelho = mais forte).
 *  - `rail`: barra de destaque na borda esquerda da primeira célula da
 *    linha — o mesmo princípio de intensidade crescente.
 *  - `dot` / `text`: usados no badge de status.
 *  - `chip`: badge "pill" preenchido (fundo tingido + texto colorido).
 */
export const STATUS_COLOR_CLASSES = {
  green: {
    row: "hover:bg-white/5",
    rail: "border-l-2 border-l-transparent",
    dot: "bg-status-green",
    text: "text-status-green",
    chip: "bg-status-green/10 text-status-green ring-1 ring-status-green/25",
  },
  yellow: {
    row: "bg-status-yellow/5 hover:bg-status-yellow/10",
    rail: "border-l-2 border-l-status-yellow/70",
    dot: "bg-status-yellow",
    text: "text-status-yellow",
    chip: "bg-status-yellow/15 text-status-yellow ring-1 ring-status-yellow/30",
  },
  orange: {
    row: "bg-status-orange/10 hover:bg-status-orange/15",
    rail: "border-l-2 border-l-status-orange/80",
    dot: "bg-status-orange",
    text: "text-status-orange",
    chip: "bg-status-orange/15 text-status-orange ring-1 ring-status-orange/30",
  },
  red: {
    row: "bg-status-red/15 hover:bg-status-red/20",
    rail: "border-l-2 border-l-status-red",
    dot: "bg-status-red",
    text: "text-status-red",
    chip: "bg-status-red/15 text-status-red ring-1 ring-status-red/30",
  },
};
