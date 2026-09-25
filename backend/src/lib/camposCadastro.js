// AJUSTE 21 — extraído de cadastros.controller.js (que definia estas mesmas
// funções localmente desde o AJUSTE 19) pra virar um módulo compartilhado.
// Motivo: o novo PATCH /api/associados/:cpf_cnpj/cadastro (edição parcial,
// registroAssociados.controller.js) precisa converter/validar/calcular os
// campos de cadastro EXATAMENTE do mesmo jeito que POST /api/cadastros
// sempre fez — pedido explícito do brief ("mesma validação"/"mesma
// fórmula"). Compartilhar as funções (em vez de duplicar) garante que os
// dois caminhos nunca divergem com o tempo — mesmo padrão de
// src/lib/cpfCnpj.js (pura, sem I/O).
//
// `cadastros.controller.js` (POST) e `registroAssociados.controller.js`
// (PATCH) importam tudo daqui; nenhum dos dois define sua própria versão.

const DESCRICOES_SERVICO_VALIDAS = [
  'Anuidade (PIX)',
  'Anuidade (Boleto)',
  'Anuidade (Cartão de Crédito)',
  'Recorrência Cartão de Crédito (Anuidade)',
];

const TIPOS_PESSOA_VALIDOS = ['PF', 'PJ'];

function arredondar2(valor) {
  return Math.round((valor + Number.EPSILON) * 100) / 100;
}

function textoOuNull(valor) {
  if (typeof valor !== 'string') return null;
  const limpo = valor.trim();
  return limpo === '' ? null : limpo;
}

/** "YYYY-MM-DD" (campo <input type="date">) -> Date (meia-noite UTC) | null. Nunca lança — data inválida vira null, sem derrubar a chamada por causa disso (mesmo comportamento desde sempre, ver docblock original em cadastros.controller.js). */
function dataOuNull(valor) {
  const limpo = textoOuNull(valor);
  if (!limpo) return null;
  const data = new Date(`${limpo}T00:00:00.000Z`);
  return Number.isNaN(data.getTime()) ? null : data;
}

/**
 * String decimal (ex.: "1234.56", já em reais) OU number -> number | null.
 * AJUSTE 21 — aceita `number` direto além de string: POST /api/cadastros
 * sempre mandou string (payload de formulário HTML), mas o PATCH novo
 * recebe JSON de verdade, onde o frontend pode perfeitamente mandar um
 * number. Comportamento pra string continua idêntico ao original.
 */
function decimalOuNull(valor) {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  const limpo = textoOuNull(valor);
  if (limpo === null) return null;
  const numero = Number(limpo);
  return Number.isFinite(numero) ? numero : null;
}

/** Mesma ideia de `decimalOuNull` acima, mas pra inteiro (numero_parcelas). */
function inteiroOuNull(valor) {
  if (typeof valor === 'number') return Number.isFinite(valor) ? Math.trunc(valor) : null;
  const limpo = textoOuNull(valor);
  if (limpo === null) return null;
  const numero = parseInt(limpo, 10);
  return Number.isFinite(numero) ? numero : null;
}

/**
 * (valorTotal - valorEntrada) / numeroParcelas, só quando numeroParcelas > 1
 * e valorTotal preenchido — mesma fórmula usada de verdade em
 * contratosGeracao.service.js ({{Valor da Parcela}}). `null` em qualquer
 * outro caso (inclusive numeroParcelas <= 1 — "a parcela" é o valor total
 * inteiro nesse caso, não faz sentido gravar um valor separado).
 */
function calcularValorParcela({ valorTotal, valorEntrada, numeroParcelas }) {
  if (valorTotal === null || valorTotal === undefined) return null;
  if (!numeroParcelas || numeroParcelas <= 1) return null;
  return arredondar2((valorTotal - (valorEntrada ?? 0)) / numeroParcelas);
}

/**
 * AJUSTE 21 — campo `Decimal` do Prisma (decimal.js por baixo, ver
 * schema.prisma: valor_entrada/valor_parcela/valor_total/desconto_parcela)
 * -> number | null. Usado só pra RELER um valor já salvo no banco (ex.:
 * mesclar com o que veio no PATCH antes de recalcular valor_parcela) —
 * nunca pra decidir o que é GRAVADO (isso é sempre `decimalOuNull` acima).
 */
function decimalPrismaParaNumeroOuNull(valor) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === 'number') return valor;
  if (typeof valor.toNumber === 'function') return valor.toNumber();
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : null;
}

module.exports = {
  DESCRICOES_SERVICO_VALIDAS,
  TIPOS_PESSOA_VALIDOS,
  arredondar2,
  textoOuNull,
  dataOuNull,
  decimalOuNull,
  inteiroOuNull,
  calcularValorParcela,
  decimalPrismaParaNumeroOuNull,
};
