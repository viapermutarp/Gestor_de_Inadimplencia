// Máscaras de digitação (live) e utilitários de formatação/validação para o
// formulário de Cadastro/Faturamento. Diferente de lib/format.js (que só
// formata valores para EXIBIÇÃO, ex. em tabelas), estas funções são pensadas
// para serem usadas em onChange de <input>, mantendo o campo mascarado
// enquanto o usuário digita.

export function apenasDigitos(valor) {
  return (valor || "").replace(/\D/g, "");
}

/** Máscara de CPF: 000.000.000-00 (até 11 dígitos). */
export function maskCpf(valor) {
  const d = apenasDigitos(valor).slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9, 11)}`;
}

/** Máscara de CNPJ: 00.000.000/0000-00 (até 14 dígitos). */
export function maskCnpj(valor) {
  const d = apenasDigitos(valor).slice(0, 14);
  if (d.length <= 2) return d;
  if (d.length <= 5) return `${d.slice(0, 2)}.${d.slice(2)}`;
  if (d.length <= 8) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5)}`;
  if (d.length <= 12) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8)}`;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12, 14)}`;
}

/** Aplica a máscara de CPF ou CNPJ conforme o Tipo de Pessoa ("PF"/"PJ"). */
export function maskCpfCnpj(valor, tipoPessoa) {
  return tipoPessoa === "PF" ? maskCpf(valor) : maskCnpj(valor);
}

/** Máscara de CEP: 00000-000. */
export function maskCep(valor) {
  const d = apenasDigitos(valor).slice(0, 8);
  if (d.length <= 5) return d;
  return `${d.slice(0, 5)}-${d.slice(5, 8)}`;
}

/** Máscara de celular/telefone: (00) 00000-0000 (móvel) ou (00) 0000-0000 (fixo). */
export function maskCelular(valor) {
  const d = apenasDigitos(valor).slice(0, 11);
  if (d.length === 0) return "";
  if (d.length <= 2) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7, 11)}`;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(valor) {
  return EMAIL_REGEX.test((valor || "").trim());
}

// --- Campos monetários -----------------------------------------------------
// Guardamos o valor em centavos (inteiro) no estado do formulário e derivamos
// a exibição mascarada ("R$ 1.234,56") a partir dele. Isso evita os problemas
// clássicos de cursor/arredondamento de máscaras de moeda baseadas em string.

const moedaFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

/** Extrai os centavos digitados a partir do valor bruto de um <input>. */
export function digitosParaCentavos(valorDigitado) {
  const digitos = apenasDigitos(valorDigitado);
  if (!digitos) return null;
  return parseInt(digitos, 10);
}

/** Formata centavos (inteiro ou null) para exibição no input, ex.: "R$ 1.234,56". */
export function formatCentavosInput(centavos) {
  if (centavos === null || centavos === undefined || centavos === "") return "";
  const numero = Number(centavos) / 100;
  if (Number.isNaN(numero)) return "";
  return moedaFormatter.format(numero);
}

/** Converte centavos para a string decimal enviada ao backend, ex.: "1500.00". */
export function centavosParaDecimalString(centavos) {
  const numero = (Number(centavos) || 0) / 100;
  return numero.toFixed(2);
}

export const UFS = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA",
  "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN",
  "RS", "RO", "RR", "SC", "SP", "SE", "TO",
];

export const DESCRICOES_SERVICO = [
  "Anuidade (PIX)",
  "Anuidade (Boleto)",
  "Anuidade (Cartão de Crédito)",
  "Recorrência Cartão de Crédito (Anuidade)",
];

export const OPCOES_PARCELAS = Array.from({ length: 12 }, (_, i) => i + 1);
