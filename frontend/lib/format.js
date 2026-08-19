const currencyFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

const dateFormatter = new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC" });

const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
});

export function formatCurrency(value) {
  const num = Number(value);
  if (Number.isNaN(num)) return "-";
  return currencyFormatter.format(num);
}

export function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return dateFormatter.format(date);
}

export function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return dateTimeFormatter.format(date);
}

const MESES_ABREVIADOS = [
  "Jan",
  "Fev",
  "Mar",
  "Abr",
  "Mai",
  "Jun",
  "Jul",
  "Ago",
  "Set",
  "Out",
  "Nov",
  "Dez",
];

/**
 * "2026-01" -> "Jan/26". Trabalha só com a string "YYYY-MM" (sem passar por
 * Date, para não sofrer problema de fuso horário) — usado pelo eixo X do
 * gráfico de evolução mensal.
 */
export function formatMesAbreviado(mesStr) {
  if (typeof mesStr !== "string") return "-";
  const [ano, mes] = mesStr.split("-").map(Number);
  if (!ano || !mes || mes < 1 || mes > 12) return mesStr;
  return `${MESES_ABREVIADOS[mes - 1]}/${String(ano).slice(-2)}`;
}
