const prisma = require('../config/prisma');
const {
  qualificacaoDetalhe,
  creditosVps,
  clausulaPagamentoAvista,
  clausulaPagamentoParcelado,
  clausulaPagamentoRecorrente,
  valorEmReaisPorExtenso,
  numeroPorExtensoFeminino,
  formatarMoeda,
} = require('../lib/contratoVariaveis');
const { gerarDocxBuffer } = require('./docx.service');
const { obterClienteDrive, criarPasta, uploadDocx } = require('./drive.service');

const DESCRICAO_RECORRENCIA = 'Recorrência Cartão de Crédito (Anuidade)';

// Mesmo rótulo exibido na tela /contratos (frontend) pro campo "Tipo" do
// modelo — o banco guarda só o código ("TERMO"/"ADITIVO"), a tela é quem
// traduz pro texto completo. Precisamos do mesmo texto aqui pra montar o
// nome do arquivo (ver `nomeArquivoContrato`), então replicamos o mapeamento
// (mantém os dois em sincronia se um novo tipo for adicionado).
const TIPO_MODELO_LABEL = {
  TERMO: 'Termo de Associação',
  ADITIVO: 'Aditivo Contratual',
};

// Caracteres inválidos/problemáticos em nome de arquivo (Windows: < > : " /
// \ | ? * e controles; "/" é o mais provável de aparecer por engano, ex.:
// alguém colando um CNPJ formatado junto da Razão Social). Substituídos por
// espaço, nunca removidos "colados" (evita grudar duas palavras), com os
// espaços resultantes colapsados e aparados no fim.
// eslint-disable-next-line no-control-regex
const CARACTERES_INVALIDOS_ARQUIVO = /[\\/:*?"<>|\x00-\x1f]/g;

function sanitizarNomeArquivo(texto) {
  return String(texto || '')
    .replace(CARACTERES_INVALIDOS_ARQUIVO, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Nome do arquivo .docx de um contrato gerado: "{Tipo} - {Razão Social}.docx".
 * "{Tipo}" é o rótulo do campo "Tipo" do ModeloContrato (Termo de
 * Associação/Aditivo Contratual — não o campo "Nome", que pode ter texto
 * extra tipo "(Pessoa Jurídica)"). "{Razão Social}" vem sempre do payload do
 * Cadastro, PF ou PJ (aqui esse campo é sempre preenchido na prática,
 * independente do tipo de pessoa). Cada contrato gerado tem seu próprio
 * nome, mesmo quando várias saem juntas pro mesmo Cadastro.
 */
function nomeArquivoContrato(modelo, dicionario) {
  const tipoLabel = TIPO_MODELO_LABEL[modelo.tipo] || modelo.tipo;
  const razaoSocial = dicionario['Razão Social'] || '';
  const base = sanitizarNomeArquivo(`${tipoLabel} - ${razaoSocial}`);
  return `${base}.docx`;
}

// Mapeia "Descrição do Serviço" pro texto de "forma de pagamento" usado nas
// cláusulas à vista/parcelado — não existe um campo próprio de forma de
// pagamento no formulário hoje, então derivamos daqui. Ajustar esta tabela
// (e não o texto das cláusulas em si) se a redação precisar mudar.
const FORMA_PAGAMENTO_POR_DESCRICAO = {
  'Anuidade (PIX)': 'PIX',
  'Anuidade (Boleto)': 'boleto bancário',
  'Anuidade (Cartão de Crédito)': 'cartão de crédito',
};

function paraNumero(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** "YYYY-MM-DD" (formato do DatePicker/backend) -> "DD/MM/YYYY". Se já vier em outro formato, devolve como está. */
function formatarDataBr(data) {
  if (!data) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(data));
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return String(data);
}

/**
 * Soma "meses" a uma data "DD/MM/YYYY", preservando o dia quando possível
 * e ajustando pro último dia do mês de destino quando o dia de origem não
 * existir nele (ex.: 31/01 + 1 mês -> 28/02 ou 29/02, nunca "03/03").
 */
function somarMeses(dataBr, meses) {
  const [diaStr, mesStr, anoStr] = dataBr.split('/');
  const dia = Number(diaStr);
  const totalMeses = Number(mesStr) - 1 + meses;
  const ano = Number(anoStr) + Math.floor(totalMeses / 12);
  const mes = ((totalMeses % 12) + 12) % 12; // 0-indexado
  const ultimoDiaDoMes = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
  const diaFinal = Math.min(dia, ultimoDiaDoMes);
  const data = new Date(Date.UTC(ano, mes, diaFinal));
  return `${pad2(data.getUTCDate())}/${pad2(data.getUTCMonth() + 1)}/${data.getUTCFullYear()}`;
}

function arredondar2(valor) {
  return Math.round(valor * 100) / 100;
}

/**
 * Resolve a "Data da Entrada" a ser usada nas cláusulas de pagamento e no
 * token solto {{Data da Entrada}}: usa o campo "Data da Entrada" do
 * formulário quando preenchido (mesmo formato de "Data Vencimento",
 * YYYY-MM-DD); se vier vazio, cai no fallback antigo — a data em que o
 * Cadastro foi enviado (`criado_em`), assumindo que a entrada foi paga "no
 * ato da assinatura". O fallback existe só como rede de segurança pra
 * cadastros antigos (anteriores a este campo) e pra quem não preencher —
 * nunca trava a geração por falta desse campo.
 */
function resolverDataEntrada(payload, dataCadastro) {
  const dataEntradaCampo = formatarDataBr(payload['Data da Entrada']);
  if (dataEntradaCampo) return dataEntradaCampo;
  return formatarDataBr(dataCadastro.toISOString().slice(0, 10));
}

/**
 * Decide qual cláusula de pagamento usar e monta o texto final, a partir
 * do payload de POST /api/cadastros e da data em que o registro foi
 * criado (usada como fallback de "data da entrada" — ver
 * `resolverDataEntrada`).
 *
 * Roteamento: "Descrição do Serviço" === Recorrência -> sempre recorrente;
 * caso contrário, "Número de Parcelas" <= 1 -> à vista, > 1 -> parcelado
 * (independente de PIX/Boleto/Cartão, já que qualquer um desses pode ser
 * parcelado em mais de 1x no formulário atual).
 */
function resolverClausulaPagamento(payload, dataCadastro) {
  const descricao = payload['Descrição do Serviço'] || '';
  const valorTotal = paraNumero(payload['Valor Total']);
  const valorEntrada = paraNumero(payload['Valor da Entrada']);
  const desconto = paraNumero(payload['Desconto Parcela']);
  const numeroParcelas = Math.max(parseInt(payload['Número de Parcelas'], 10) || 1, 1);
  const dataVencimento = formatarDataBr(payload['Data Vencimento']);
  const dataEntrada = resolverDataEntrada(payload, dataCadastro);

  if (descricao === DESCRICAO_RECORRENCIA) {
    const valorParcela = arredondar2((valorTotal - valorEntrada) / numeroParcelas);
    return clausulaPagamentoRecorrente({
      valorTotal,
      valorEntrada,
      dataEntrada,
      qtdParcelas: numeroParcelas,
      valorParcela,
      primeiraData: dataVencimento,
      desconto,
    });
  }

  const formaPagamento = FORMA_PAGAMENTO_POR_DESCRICAO[descricao] || 'meio de pagamento não informado';

  if (numeroParcelas <= 1) {
    return clausulaPagamentoAvista({ valorTotal, formaPagamento, desconto });
  }

  const valorParcela = arredondar2((valorTotal - valorEntrada) / numeroParcelas);
  const parcelas = Array.from({ length: numeroParcelas }, (_, i) => ({
    valor: valorParcela,
    vencimento: somarMeses(dataVencimento, i),
  }));

  return clausulaPagamentoParcelado({
    valorTotal,
    valorEntrada,
    dataEntrada,
    parcelas,
    formaPagamento,
    desconto,
  });
}

/**
 * Monta o dicionário completo de variáveis disponíveis pra resolver
 * placeholders {{...}} num modelo de contrato, a partir do payload de
 * POST /api/cadastros e da data de criação do registro.
 */
function resolverDicionario(payload, dataCadastro) {
  const tipoPessoa = payload['Tipo de Pessoa'] || 'PJ';
  const nomeAssociado =
    tipoPessoa === 'PJ'
      ? payload['Razão Social'] || payload['Contato'] || ''
      : payload['Contato'] || payload['Razão Social'] || '';

  const qualificacao = qualificacaoDetalhe({
    tipoPessoa,
    endereco: payload['Endereço'] || '',
    numero: payload['Número'] || '',
    complemento: payload['Complemento'] || '',
    bairro: payload['Bairro'] || '',
    cidade: payload['Cidade'] || '',
    uf: payload['UF'] || '',
    cep: payload['CEP'] || '',
    cpfCnpj: payload['CNPJ/CPF'] || '',
  });

  // "Créditos VP$" vem do campo próprio adicionado ao formulário de
  // Cadastro (dropdown 8.000 / 2.000 / Nenhum) — ver premissas no README,
  // já que não havia nenhum campo existente de onde derivar esse valor.
  const creditosVpsValor = parseInt(payload['Créditos VP$'], 10) || 0;
  const creditos = creditosVps(creditosVpsValor);

  // Peças soltas de pagamento — os mesmos dados que já alimentam
  // "Cláusula de Pagamento" (resolverClausulaPagamento, acima), expostos
  // como tokens individuais pra quem quiser montar a própria redação em
  // vez de usar o bloco pronto. Não é lógica nova: {{Cláusula de
  // Pagamento}} continua funcionando exatamente como antes, coexistindo
  // com estes tokens.
  const valorTotal = paraNumero(payload['Valor Total']);
  const valorEntrada = paraNumero(payload['Valor da Entrada']);
  const numeroParcelas = Math.max(parseInt(payload['Número de Parcelas'], 10) || 1, 1);
  const valorParcela = arredondar2((valorTotal - valorEntrada) / numeroParcelas);
  const dataEntrada = resolverDataEntrada(payload, dataCadastro);

  return {
    'Razão Social': payload['Razão Social'] || '',
    'Nome Fantasia': payload['Nome Fantasia'] || '',
    'CNPJ/CPF': payload['CNPJ/CPF'] || '',
    'Endereço': payload['Endereço'] || '',
    'Número': payload['Número'] || '',
    'Complemento': payload['Complemento'] || '',
    'Bairro': payload['Bairro'] || '',
    'Cidade': payload['Cidade'] || '',
    UF: payload['UF'] || '',
    CEP: payload['CEP'] || '',
    'E-mail': payload['E-mail'] || '',
    'Celular': payload['Celular'] || '',
    'Contato': payload['Contato'] || '',
    'Tipo de Pessoa': tipoPessoa,
    'Nome do Associado': nomeAssociado,
    'Qualificação': qualificacao,
    'Créditos VP$ Quantidade': creditos.qtd,
    'Créditos VP$ Valor': creditos.valor,
    'Cláusula de Pagamento': resolverClausulaPagamento(payload, dataCadastro),
    'Número de Parcelas': payload['Número de Parcelas'] || '',
    'Número de Parcelas Por Extenso': numeroPorExtensoFeminino(numeroParcelas),
    'Valor Total': formatarMoeda(valorTotal),
    'Valor Total Por Extenso': valorEmReaisPorExtenso(valorTotal),
    'Valor da Entrada': formatarMoeda(valorEntrada),
    'Valor da Entrada Por Extenso': valorEmReaisPorExtenso(valorEntrada),
    'Data da Entrada': dataEntrada,
    'Valor da Parcela': formatarMoeda(valorParcela),
    'Valor da Parcela Por Extenso': valorEmReaisPorExtenso(valorParcela),
    // Valor bruto do campo "Data Vencimento" (data da primeira/única
    // parcela), formatado dd/mm/aaaa — não é a lista completa de
    // vencimentos de cada parcela (isso só existe hoje dentro do texto
    // montado por resolverClausulaPagamento), só a data única do campo do
    // formulário, solta.
    'Data Vencimento': formatarDataBr(payload['Data Vencimento']),
  };
}

/**
 * Substitui toda ocorrência de "{{Nome Da Variável}}" no HTML pelo valor
 * resolvido no dicionário. Feito direto na string HTML (regex simples) —
 * não quebra tags, mas depende de a placeholder inteira estar fora de
 * qualquer formatação parcial (ver aviso na tela de Contratos). Chaves sem
 * correspondência no dicionário são deixadas como estão (não apaga nem
 * lança erro), pra um typo no nome da variável não travar a geração do
 * documento inteiro — só o placeholder específico fica sem substituir.
 */
function resolverPlaceholders(html, dicionario) {
  return html.replace(/\{\{([^}]+)\}\}/g, (match, chave) => {
    const valor = dicionario[chave.trim()];
    return valor !== undefined && valor !== null ? String(valor) : match;
  });
}

/**
 * Gera e sobe pro Drive os contratos selecionados num Cadastro
 * (CadastroEnviado.modelosContratoIds) — chamada de forma assíncrona
 * (fire-and-forget) depois que POST /api/cadastros já respondeu, pra não
 * atrasar o formulário. Nunca lança: qualquer falha (Drive não
 * configurado, pasta raiz ausente, erro de rede) é só logada; o registro
 * do Cadastro em si já foi salvo antes disso e não é afetado.
 *
 * Se algum modelo específico falhar (ex.: erro pontual do Drive), os
 * demais continuam sendo gerados — o resultado parcial é salvo mesmo
 * assim, em vez de tudo ou nada.
 */
async function gerarContratosParaCadastro(cadastroId) {
  let cadastro;
  try {
    cadastro = await prisma.cadastroEnviado.findUnique({ where: { id: cadastroId } });
  } catch (err) {
    console.error(`[contratos] Falha ao carregar o cadastro ${cadastroId}:`, err.message);
    return;
  }

  if (!cadastro) return;
  if (!Array.isArray(cadastro.modelosContratoIds) || cadastro.modelosContratoIds.length === 0) return;

  // Multi-franquia — Passo 4, Item 4: credencial resolvida pela franquia do
  // PRÓPRIO cadastro (não mais global/única do processo) — ver
  // drive.service.js:obterClienteDrive.
  const drive = await obterClienteDrive(cadastro.franquiaId);
  if (!drive) {
    console.error(
      `[contratos] Credencial do Google (conta de serviço) não configurada pra esta franquia — geração de contratos pulada (cadastro ${cadastroId}).`
    );
    return;
  }

  // Multi-franquia — Passo 4, Item 3: filtro explícito por "franquiaId"
  // (defesa em profundidade). Este job roda fora do req.prisma (é
  // assíncrono, disparado via setImmediate depois que POST /api/cadastros
  // já respondeu — ver docblock acima), então nada aqui passa pela
  // extension de isolamento (prismaComEscopo.js). A validação de entrada em
  // cadastros.controller.js (Item 2) já deveria ter bloqueado qualquer id de
  // outra franquia antes de chegar a este ponto — mas nunca confiar só numa
  // camada: mesmo que aquela validação falhe/seja contornada, esta query
  // nunca retorna um ModeloContrato de franquia diferente da do próprio
  // cadastro. "cadastro.franquiaId" já está disponível aqui (CadastroEnviado
  // é modelo de escopo direto — findUnique acima não filtra, mas o registro
  // já carrega sua própria franquia).
  const modelos = await prisma.modeloContrato.findMany({
    where: { id: { in: cadastro.modelosContratoIds }, franquiaId: cadastro.franquiaId },
  });

  if (modelos.length === 0) {
    console.error(`[contratos] Nenhum dos modelos selecionados foi encontrado (cadastro ${cadastroId}).`);
    return;
  }

  if (modelos.length !== cadastro.modelosContratoIds.length) {
    console.error(
      `[contratos] ${cadastro.modelosContratoIds.length - modelos.length} modelo(s) selecionado(s) não pertencem à franquia do cadastro ${cadastroId} (ou não existem mais) — gerando só os válidos.`
    );
  }

  const dicionario = resolverDicionario(cadastro.payload, cadastro.criadoEm);
  const nomePasta = cadastro.nomePasta?.trim() || dicionario['Nome do Associado'] || `Cadastro ${cadastro.id}`;

  let pasta;
  try {
    // "cadastro.franquiaId" precisa ser passado explicitamente desde o
    // Passo 4, Item 1 (config.service.js parou de ter fallback interno de
    // franquia) — ver comentário em drive.service.js:criarPasta.
    pasta = await criarPasta(nomePasta, drive, cadastro.franquiaId);
  } catch (err) {
    console.error(`[contratos] Falha ao criar a pasta "${nomePasta}" no Drive (cadastro ${cadastroId}):`, err.message);
    return;
  }

  const arquivosGerados = [];
  for (const modelo of modelos) {
    try {
      const htmlFinal = resolverPlaceholders(modelo.conteudo, dicionario);
      const buffer = await gerarDocxBuffer(htmlFinal);
      const nomeArquivo = nomeArquivoContrato(modelo, dicionario);
      const arquivo = await uploadDocx({ nome: nomeArquivo, buffer, pastaId: pasta.id, drive });
      arquivosGerados.push({
        modeloContratoId: modelo.id,
        nome: nomeArquivo,
        driveFileId: arquivo.id,
        driveFileUrl: arquivo.url,
      });
    } catch (err) {
      console.error(
        `[contratos] Falha ao gerar/subir o contrato "${modelo.nome}" (cadastro ${cadastroId}):`,
        err.message
      );
    }
  }

  try {
    await prisma.cadastroEnviado.update({
      where: { id: cadastroId },
      data: { pastaDriveId: pasta.id, arquivosGerados },
    });
  } catch (err) {
    console.error(`[contratos] Falha ao salvar o resultado da geração (cadastro ${cadastroId}):`, err.message);
  }
}

module.exports = {
  resolverDicionario,
  resolverPlaceholders,
  resolverClausulaPagamento,
  formatarDataBr,
  somarMeses,
  nomeArquivoContrato,
  sanitizarNomeArquivo,
  gerarContratosParaCadastro,
};
