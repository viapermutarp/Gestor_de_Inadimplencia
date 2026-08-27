// Funções de geração de texto jurídico (números por extenso, qualificação
// PF/PJ, cláusulas de pagamento à vista/parcelado/recorrente) usadas na
// resolução de variáveis dos modelos de contrato (ver
// src/services/contratos-geracao.service.js).
//
// Copiadas verbatim (sem alteração) do texto fornecido pelo usuário —
// validadas contra 2 contratos reais já assinados, batendo palavra por
// palavra (ver test-contrato-variaveis.js). NÃO alterar o comportamento
// destas funções sem re-rodar esse teste de aceitação.

// ---------- Número por extenso (português, valores em Reais) ----------
const UNIDADES = ['zero','um','dois','três','quatro','cinco','seis','sete','oito','nove'];
const DEZ_A_DEZENOVE = ['dez','onze','doze','treze','catorze','quinze','dezesseis','dezessete','dezoito','dezenove'];
const DEZENAS = ['','','vinte','trinta','quarenta','cinquenta','sessenta','setenta','oitenta','noventa'];
const CENTENAS = ['','cento','duzentos','trezentos','quatrocentos','quinhentos','seiscentos','setecentos','oitocentos','novecentos'];
function grupoPorExtenso(n) {
  if (n === 0) return '';
  if (n === 100) return 'cem';
  let partes = [];
  const c = Math.floor(n / 100);
  const resto = n % 100;
  if (c > 0) partes.push(CENTENAS[c]);
  if (resto > 0) {
    if (resto < 10) {
      partes.push(UNIDADES[resto]);
    } else if (resto < 20) {
      partes.push(DEZ_A_DEZENOVE[resto - 10]);
    } else {
      const d = Math.floor(resto / 10);
      const u = resto % 10;
      partes.push(u > 0 ? `${DEZENAS[d]} e ${UNIDADES[u]}` : DEZENAS[d]);
    }
  }
  return partes.join(' e ');
}
function numeroPorExtenso(valorInteiro) {
  if (valorInteiro === 0) return 'zero';
  const milhoes = Math.floor(valorInteiro / 1000000);
  const milhares = Math.floor((valorInteiro % 1000000) / 1000);
  const unidades = valorInteiro % 1000;
  let segmentos = [];
  if (milhoes > 0) {
    segmentos.push({ texto: milhoes === 1 ? 'um milhão' : `${grupoPorExtenso(milhoes)} milhões`, valor: milhoes * 1000000 });
  }
  if (milhares > 0) {
    segmentos.push({ texto: milhares === 1 ? 'mil' : `${grupoPorExtenso(milhares)} mil`, valor: milhares * 1000 });
  }
  if (unidades > 0) {
    segmentos.push({ texto: grupoPorExtenso(unidades), valor: unidades });
  }
  if (segmentos.length === 1) return segmentos[0].texto;
  const ultimo = segmentos[segmentos.length - 1];
  const anteriores = segmentos.slice(0, -1);
  const textoAnteriores = anteriores.map(s => s.texto).join(', ');
  return `${textoAnteriores} e ${ultimo.texto}`;
}
function valorEmReaisPorExtenso(valor) {
  const inteiro = Math.floor(valor);
  const centavos = Math.round((valor - inteiro) * 100);
  const inteiroExtenso = numeroPorExtenso(inteiro);
  const sufixoReal = inteiro === 1 ? 'real' : 'reais';
  if (centavos === 0) return `${inteiroExtenso} ${sufixoReal}`;
  const centavosExtenso = numeroPorExtenso(centavos);
  const sufixoCentavo = centavos === 1 ? 'centavo' : 'centavos';
  return `${inteiroExtenso} ${sufixoReal} e ${centavosExtenso} ${sufixoCentavo}`;
}
function formatarMoeda(v) {
  return v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// ---------- Qualificação (PF ou PJ) ----------
function qualificacaoDetalhe(dados) {
  const { tipoPessoa, endereco, numero, complemento, bairro, cidade, uf, cep, cpfCnpj } = dados;
  const enderecoCompleto = complemento ? `${endereco}, ${numero}, ${complemento}` : `${endereco}, ${numero}`;
  if (tipoPessoa === 'PJ') {
    return `pessoa jurídica de direito privado, com sede na ${enderecoCompleto}, Bairro ${bairro}, ${cidade}/${uf}, CEP ${cep}, inscrito no CNPJ sob nº ${cpfCnpj}, neste ato devidamente representada nos termos do seu Contrato Social`;
  }
  return `profissional autônomo(a), residente à ${enderecoCompleto}, Bairro ${bairro}, ${cidade}/${uf}, CEP ${cep}, inscrito no CPF sob nº ${cpfCnpj}, neste ato devidamente representada nos termos do seu documento profissional apresentado`;
}
// ---------- Créditos VP$ (só 3 valores possíveis: 8000, 2000, 0) ----------
function creditosVps(valor) {
  const tabela = {
    8000: { qtd: '8.000 (oito mil)', valor: '8.000,00 (oito mil reais)' },
    2000: { qtd: '2.000 (dois mil)', valor: '2.000,00 (dois mil reais)' },
    0:    { qtd: '0 (zero)',         valor: '0,00 (zero reais)' }
  };
  const entrada = tabela[valor];
  if (!entrada) throw new Error(`Valor de créditos VP$ inválido: ${valor}. Esperado 8000, 2000 ou 0.`);
  return entrada;
}
const ORDINAIS = ['primeira','segunda','terceira','quarta','quinta','sexta','sétima','oitava','nona','décima','décima primeira','décima segunda'];
const NUMERO_FEMININO = ['zero','uma','duas','três','quatro','cinco','seis','sete','oito','nove','dez','onze','doze','treze','catorze','quinze','dezesseis','dezessete','dezoito','dezenove','vinte','vinte e uma','vinte e duas','vinte e três','vinte e quatro'];
function numeroPorExtensoFeminino(n) {
  if (n >= 0 && n < NUMERO_FEMININO.length) return NUMERO_FEMININO[n];
  return numeroPorExtenso(n);
}
// ---------- Cláusula de pagamento: à vista / parcelado / recorrente ----------
function clausulaPagamentoAvista({ valorTotal, formaPagamento, desconto }) {
  let trechoDesconto = '';
  if (desconto > 0) {
    trechoDesconto = `, sendo concedido desconto de R$ ${formatarMoeda(desconto)} (${valorEmReaisPorExtenso(desconto)}) para o pagamento realizado até a data combinada`;
  }
  return `O ASSOCIADO pagará adesão ao FRANQUEADO, no ato da assinatura do presente instrumento, o valor de R$ ${formatarMoeda(valorTotal)} (${valorEmReaisPorExtenso(valorTotal)}), à vista, por meio de ${formaPagamento}${trechoDesconto}, a título de anuidade.`;
}
function clausulaPagamentoParcelado({ valorTotal, valorEntrada, dataEntrada, parcelas, formaPagamento, desconto }) {
  const valorSaldo = valorTotal - valorEntrada;
  const qtdParcelas = parcelas.length;
  const valorParcela = parcelas[0].valor;
  let trechoEntrada = '';
  if (valorEntrada > 0) {
    trechoEntrada = `, tendo pago uma entrada de R$ ${formatarMoeda(valorEntrada)} (${valorEmReaisPorExtenso(valorEntrada)}) no dia ${dataEntrada}`;
  }
  const qtdExtenso = numeroPorExtensoFeminino(qtdParcelas);
  const substantivoParcela = qtdParcelas === 1 ? 'parcela' : 'parcelas';
  const verboParcela = qtdParcelas === 1 ? 'mensal e sucessiva' : 'mensais e sucessivas';
  const trechosVencimento = parcelas.map((p, i) => `${i === 0 ? '' : 'da '}${ORDINAIS[i] || `${i+1}ª`} parcela em ${p.vencimento}`);
  let trechoVencimentos;
  if (trechosVencimento.length === 1) {
    trechoVencimentos = `com vencimento da ${trechosVencimento[0]}`;
  } else {
    const ultimo = trechosVencimento[trechosVencimento.length - 1];
    const resto = trechosVencimento.slice(0, -1).join(', ');
    trechoVencimentos = `com vencimento da ${resto} e ${ultimo}`;
  }
  let trechoDesconto = '';
  if (desconto > 0) {
    trechoDesconto = `, sendo concedido desconto de R$ ${formatarMoeda(desconto)} (${valorEmReaisPorExtenso(desconto)}) para os pagamentos realizados até a data de vencimento de cada parcela`;
  }
  return `O ASSOCIADO pagará adesão ao FRANQUEADO, no ato da assinatura do presente instrumento, o valor de R$ ${formatarMoeda(valorTotal)} (${valorEmReaisPorExtenso(valorTotal)})${trechoEntrada}, restando o valor de R$ ${formatarMoeda(valorSaldo)} (${valorEmReaisPorExtenso(valorSaldo)}) parcelado em ${qtdParcelas} (${qtdExtenso}) ${substantivoParcela} ${verboParcela} de R$ ${formatarMoeda(valorParcela)}, por meio de ${formaPagamento}, ${trechoVencimentos}${trechoDesconto}, a título de anuidade.`;
}
function clausulaPagamentoRecorrente({ valorTotal, valorEntrada, dataEntrada, qtdParcelas, valorParcela, primeiraData, desconto }) {
  const valorSaldo = valorTotal - valorEntrada;
  let trechoEntrada = '';
  if (valorEntrada > 0) {
    trechoEntrada = `, tendo pago uma entrada de R$ ${formatarMoeda(valorEntrada)} (${valorEmReaisPorExtenso(valorEntrada)}) no dia ${dataEntrada}`;
  }
  const qtdExtenso = numeroPorExtensoFeminino(qtdParcelas);
  const substantivoParcela = qtdParcelas === 1 ? 'parcela' : 'parcelas';
  const verboParcela = qtdParcelas === 1 ? 'mensal e sucessiva' : 'mensais e sucessivas';
  let trechoDesconto = '';
  if (desconto > 0) {
    trechoDesconto = `, sendo concedido desconto de R$ ${formatarMoeda(desconto)} (${valorEmReaisPorExtenso(desconto)}) para os pagamentos realizados até a data de vencimento de cada parcela`;
  }
  return `O ASSOCIADO pagará adesão ao FRANQUEADO, no ato da assinatura do presente instrumento, o valor de R$ ${formatarMoeda(valorTotal)} (${valorEmReaisPorExtenso(valorTotal)})${trechoEntrada}, restando o valor de R$ ${formatarMoeda(valorSaldo)} (${valorEmReaisPorExtenso(valorSaldo)}) parcelado em ${qtdParcelas} (${qtdExtenso}) ${substantivoParcela} ${verboParcela} de R$ ${formatarMoeda(valorParcela)}, por meio de pagamento recorrente no cartão de crédito, com a primeira parcela vencendo em ${primeiraData}${trechoDesconto}, a título de anuidade.`;
}
module.exports = {
  valorEmReaisPorExtenso, numeroPorExtenso, qualificacaoDetalhe, creditosVps,
  clausulaPagamentoAvista, clausulaPagamentoParcelado, clausulaPagamentoRecorrente
};
