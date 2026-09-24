// Correção pós-AJUSTE 19 — normalização de CPF/CNPJ pra comparação/busca.
//
// Usado nos 3 caminhos que escrevem `Associado.cpfCnpj` (POST /api/sync,
// POST /api/cadastros — via a mesma extension de upsert escopado, ver
// prismaComEscopo.js —, e a importação de CSV em registroAssociados.controller.js)
// e em qualquer lookup que precise reconhecer o MESMO CPF/CNPJ digitado ou
// exportado em formatos diferentes (com ou sem pontuação) como a mesma
// pessoa/empresa — nunca pra decidir o que é GRAVADO em `Associado.cpfCnpj`,
// que continua sendo o valor original, verbatim, exatamente como sempre foi
// (ver `Associado.cpfCnpjDigits` em schema.prisma, mantida em sincronia só
// pela aplicação).
function apenasDigitos(valor) {
  return typeof valor === 'string' ? valor.replace(/\D/g, '') : '';
}

module.exports = { apenasDigitos };
