const multer = require('multer');
const { serializeAssociado } = require('./associados.controller');
const { apenasDigitos } = require('../lib/cpfCnpj');
const {
  DESCRICOES_SERVICO_VALIDAS,
  TIPOS_PESSOA_VALIDOS,
  textoOuNull,
  dataOuNull,
  decimalOuNull,
  inteiroOuNull,
  calcularValorParcela,
  decimalPrismaParaNumeroOuNull,
} = require('../lib/camposCadastro');

/**
 * AJUSTE 19 — "Nova aba 'Associados' + Cadastro passa a abastecer o
 * registro do associado". Este controller cobre a PARTE NOVA da aba
 * "Associados" que NÃO já existia em associados.controller.js (Dashboard):
 *   - `listar`: busca/listagem simples da carteira cadastral completa (não
 *     filtrada por cobrança em aberto — é um cadastro, não uma tela de
 *     inadimplência).
 *   - `importarPreview`/`importarAplicar`: importação em lote de CSV no
 *     formato de exportação de contatos do Bling.
 * O detalhe (GET /api/associados/:cpfCnpj) É REAPROVEITADO de
 * associados.controller.js sem nenhuma duplicação — ver associados.routes.js
 * (a mesma rota agora aceita tanto o recurso `dashboard` quanto `associados`).
 *
 * AJUSTE 20 — "Excluir cadastro (individual e em massa)": `excluirCadastro`/
 * `excluirCadastroLote`, mais o filtro novo em `listar` (ver
 * `CAMPOS_CADASTRO`/`filtroTemCadastro` logo abaixo).
 *
 * AJUSTE 21 — "Editar cadastro do associado": `editarCadastro` (PATCH
 * parcial), reaproveitando `CAMPOS_CADASTRO` (mesma lista do DELETE) e as
 * funções de validação/conversão/cálculo de src/lib/camposCadastro.js —
 * exatamente as mesmas usadas por POST /api/cadastros (cadastros.controller.js).
 */

const LIMITE_PADRAO = 100;
const LIMITE_MAXIMO = 100;

// AJUSTE 20 — os 22 campos do AJUSTE 19 (identificação, endereço, contato,
// faturamento — ver docblock deles em schema.prisma), num lugar só, pra
// nunca esquecer um campo em algum dos 3 usos abaixo:
//   1. `filtroTemCadastro` — "tem cadastro" = pelo menos um destes != null
//      (usado por `listar` — ver AJUSTE 20 no README pro raciocínio de por
//      que isso precisou virar um filtro explícito).
//   2. `dadosCadastroNulo()` — objeto { campo: null, ... } usado por
//      `excluirCadastro`/`excluirCadastroLote` pra limpar todos de uma vez.
// NUNCA inclui "cpfCnpj"/"cpfCnpjDigits"/"nome"/"telefone"/"email" (legados,
// nunca tocados por "excluir cadastro") nem "criadoEm"/"atualizadoEm".
const CAMPOS_CADASTRO = [
  'tipoPessoa',
  'razaoSocial',
  'nomeFantasia',
  'cep',
  'endereco',
  'numero',
  'complemento',
  'bairro',
  'cidade',
  'uf',
  'contatoNome',
  'celular',
  'emailCadastro',
  'descricaoServico',
  'valorEntrada',
  'dataEntrada',
  'numeroParcelas',
  'valorParcela',
  'valorTotal',
  'dataVencimento',
  'descontoParcela',
  'observacoesCadastro',
];

/** { tipoPessoa: null, razaoSocial: null, ... } — sempre um objeto NOVO (nunca reaproveitado entre chamadas). */
function dadosCadastroNulo() {
  return Object.fromEntries(CAMPOS_CADASTRO.map((campo) => [campo, null]));
}

/** Filtro Prisma: "tem pelo menos um campo de cadastro preenchido" (OR). */
function filtroTemCadastro() {
  return { OR: CAMPOS_CADASTRO.map((campo) => ({ [campo]: { not: null } })) };
}

// multer com memoryStorage (mesmo padrão de juridicoDocumentos.controller.js)
// — o CSV nunca é escrito em disco, só processado em memória. Limite de 10MB
// é bem generoso pra um CSV de contatos (dezenas de milhares de linhas de
// texto puro cabem tranquilamente bem abaixo disso).
const LIMITE_UPLOAD_BYTES = 10 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: LIMITE_UPLOAD_BYTES } });

/**
 * Wrapper em volta de "upload.single('arquivo')", mesmo padrão de
 * juridicoDocumentos.controller.js: converte erro de tamanho excedido do
 * multer numa resposta 400 amigável, em vez de cair no errorHandler
 * genérico (500).
 */
function uploadMiddleware(req, res, next) {
  upload.single('arquivo')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      const limiteMb = (LIMITE_UPLOAD_BYTES / (1024 * 1024)).toFixed(0);
      return res.status(400).json({ error: `Arquivo excede o tamanho máximo permitido (${limiteMb}MB).` });
    }
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  });
}
exports.uploadMiddleware = uploadMiddleware;

/**
 * GET /api/associados/registro
 * GET /api/associados/registro?busca=termo
 * GET /api/associados/registro?page=2&limit=50
 *
 * Listagem simples da carteira cadastral (aba "Associados") — diferente de
 * GET /api/associados (Dashboard): não filtra por cobrança em aberto, não
 * ordena por atraso, não traz cobranças/histórico junto (lista enxuta,
 * pensada pra navegação/busca). "busca" pesquisa por nome, cpf_cnpj OU
 * e-mail (tanto o "email" legado quanto o novo "email_cadastro" — contains,
 * case-insensitive). Ordenado por nome (A-Z). Paginado (mesmo padrão do
 * resto do projeto: "page" padrão 1, "limit" padrão 100, máximo 100).
 *
 * AJUSTE 20 — só lista associado que TEM cadastro (pelo menos um dos 22
 * campos do AJUSTE 19 preenchido, ver `filtroTemCadastro`). Investigado na
 * introdução do "excluir cadastro": antes deste ajuste, `listar` não tinha
 * NENHUM filtro por cadastro — mostrava toda a carteira da franquia,
 * inclusive associado que nunca passou por Cadastro/importação (só existe
 * via sync do Asaas). Sem este filtro explícito, "excluir cadastro"
 * limparia os campos mas o associado continuaria aparecendo na aba — o
 * comportamento esperado é justamente o contrário (a aba existe pra mostrar
 * quem TEM dado de cadastro).
 */
exports.listar = async (req, res, next) => {
  try {
    const { busca, page: pageParam, limit: limitParam } = req.query;
    const termoBusca = typeof busca === 'string' ? busca.trim() : '';

    let page = parseInt(pageParam, 10);
    if (!Number.isInteger(page) || page < 1) page = 1;

    let limit = parseInt(limitParam, 10);
    if (!Number.isInteger(limit) || limit < 1) limit = LIMITE_PADRAO;
    if (limit > LIMITE_MAXIMO) limit = LIMITE_MAXIMO;

    const filtroBusca =
      termoBusca !== ''
        ? {
            OR: [
              { nome: { contains: termoBusca, mode: 'insensitive' } },
              { razaoSocial: { contains: termoBusca, mode: 'insensitive' } },
              { nomeFantasia: { contains: termoBusca, mode: 'insensitive' } },
              { cpfCnpj: { contains: termoBusca } },
              { email: { contains: termoBusca, mode: 'insensitive' } },
              { emailCadastro: { contains: termoBusca, mode: 'insensitive' } },
            ],
          }
        : null;

    const where = { AND: [filtroTemCadastro(), ...(filtroBusca ? [filtroBusca] : [])] };

    const totalRegistros = await req.prisma.associado.count({ where });
    const totalPaginas = Math.max(Math.ceil(totalRegistros / limit), 1);

    const associados = await req.prisma.associado.findMany({
      where,
      orderBy: { nome: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    });

    res.json({
      dados: associados.map(serializeAssociado),
      paginacao: {
        pagina_atual: page,
        total_paginas: totalPaginas,
        total_registros: totalRegistros,
        por_pagina: limit,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ---------------------------------------------------------------------
// Importação de CSV (formato de exportação de contatos do Bling)
// ---------------------------------------------------------------------

/**
 * Decodifica o buffer do CSV. Tenta UTF-8 primeiro; se o resultado contiver
 * o caractere de substituição U+FFFD (sinal de bytes inválidos pra UTF-8),
 * refaz como Latin-1/CP1252 — exportações do Bling/Excel no Brasil
 * frequentemente saem em Latin-1, não UTF-8. Remove BOM (U+FEFF) se
 * presente, nas duas tentativas.
 */
function decodificarCsv(buffer) {
  const semBom = (texto) => (texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto);
  const comoUtf8 = semBom(buffer.toString('utf8'));
  if (comoUtf8.includes('�')) {
    return semBom(buffer.toString('latin1'));
  }
  return comoUtf8;
}

/** Detecta o delimitador (',' ou ';') pela frequência na primeira linha — exports do Bling/Excel BR tipicamente usam ';'. */
function detectarDelimitador(texto) {
  const primeiraLinha = texto.split(/\r\n|\r|\n/, 1)[0] || '';
  const pontoEVirgula = (primeiraLinha.match(/;/g) || []).length;
  const virgula = (primeiraLinha.match(/,/g) || []).length;
  return pontoEVirgula > virgula ? ';' : ',';
}

/**
 * Parser de CSV simples (sem dependência externa) — suporta campos entre
 * aspas (incluindo delimitador/quebra de linha dentro das aspas) e aspas
 * escapadas (""). Retorna array de arrays (linhas x colunas), já sem
 * linhas totalmente vazias.
 */
function parseCsv(texto, delimitador) {
  const linhas = [];
  let linhaAtual = [];
  let campoAtual = '';
  let dentroDeAspas = false;

  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i];

    if (dentroDeAspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          campoAtual += '"';
          i += 1;
        } else {
          dentroDeAspas = false;
        }
      } else {
        campoAtual += c;
      }
      continue;
    }

    if (c === '"') {
      dentroDeAspas = true;
    } else if (c === delimitador) {
      linhaAtual.push(campoAtual);
      campoAtual = '';
    } else if (c === '\r') {
      // ignorado — tratado junto com '\n' abaixo (CRLF ou CR solto)
    } else if (c === '\n') {
      linhaAtual.push(campoAtual);
      campoAtual = '';
      linhas.push(linhaAtual);
      linhaAtual = [];
    } else {
      campoAtual += c;
    }
  }
  if (campoAtual !== '' || linhaAtual.length > 0) {
    linhaAtual.push(campoAtual);
    linhas.push(linhaAtual);
  }

  return linhas.filter((linha) => !(linha.length === 1 && linha[0].trim() === ''));
}

/** Remove acentos e normaliza pra comparar cabeçalhos sem depender de acentuação/maiúsculas exatas. */
function normalizarCabecalho(texto) {
  return (texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Mapeamento pedido no brief — colunas do CSV de exportação do Bling ->
// campos do Associado. Qualquer coluna do CSV que não bata com nenhuma
// destas chaves (Estado civil, Profissão, Vendedor, Segmento, etc.) é
// simplesmente ignorada, sem erro.
const MAPA_CABECALHOS = {
  nome: 'razaoSocial',
  fantasia: 'nomeFantasia',
  'cnpj cpf': 'cpfCnpj',
  endereco: 'endereco',
  numero: 'numero',
  complemento: 'complemento',
  bairro: 'bairro',
  cep: 'cep',
  cidade: 'cidade',
  uf: 'uf',
  celular: 'celular',
  fone: 'celular', // fallback — só usado se a coluna "Celular" não existir ou vier vazia nessa linha (ver montarLinha)
  email: 'emailCadastro',
  'e mail': 'emailCadastro',
};

const CAMPOS_TEXTO_CSV = ['razaoSocial', 'nomeFantasia', 'endereco', 'numero', 'complemento', 'bairro', 'cep', 'cidade', 'uf', 'celular', 'emailCadastro'];

// "apenasDigitos" (importado de ../lib/cpfCnpj) é usado aqui tanto pra
// VALIDAR a contagem de dígitos (11 = CPF, 14 = CNPJ — o valor gravado
// continua o original, ver docblock de `importarPreview`) quanto, desde a
// correção pós-AJUSTE 19, pra CASAR cada linha do CSV com um associado já
// existente (ver `candidatos`/`existentePorDigitos` abaixo) — nunca mais
// pelo valor exato de "cpf_cnpj", pra planilha com formatação diferente
// (com ou sem pontuação) do que já está cadastrado ser reconhecida como
// conflito, não como associado novo.

/**
 * Interpreta o cabeçalho (1ª linha do CSV) e devolve um array paralelo às
 * colunas: `indiceColuna -> { campo, ehFallbackCelular }` (ou `null` pra
 * coluna sem mapeamento — ignorada). `ehFallbackCelular` marca a coluna
 * "Fone", que só preenche `celular` quando não há coluna "Celular" própria
 * OU ela veio vazia nessa linha específica.
 */
function mapearCabecalho(linhaCabecalho) {
  let indiceColunaCelular = -1;
  let indiceColunaFone = -1;
  const mapeamento = linhaCabecalho.map((titulo, indice) => {
    const normalizado = normalizarCabecalho(titulo);
    const campo = MAPA_CABECALHOS[normalizado];
    if (normalizado === 'celular') indiceColunaCelular = indice;
    if (normalizado === 'fone') indiceColunaFone = indice;
    return campo ? { campo, colunaOriginal: titulo } : null;
  });
  return { mapeamento, indiceColunaCelular, indiceColunaFone };
}

function montarLinha(colunasLinha, mapeamento, indiceColunaCelular, indiceColunaFone) {
  const registro = {};
  mapeamento.forEach((info, indice) => {
    if (!info) return;
    const valorBruto = (colunasLinha[indice] ?? '').trim();
    if (info.campo === 'celular') {
      // "Celular" tem prioridade; "Fone" só entra se não houver coluna
      // "Celular" no CSV, ou se ela vier vazia NESTA linha.
      if (indice === indiceColunaFone) {
        const jaTemCelular =
          indiceColunaCelular >= 0 && (colunasLinha[indiceColunaCelular] ?? '').trim() !== '';
        if (jaTemCelular) return; // não sobrescreve o valor de "Celular" já capturado
      }
      if (valorBruto !== '') registro.celular = valorBruto;
      return;
    }
    if (valorBruto !== '') registro[info.campo] = valorBruto;
  });
  return registro;
}

/** Serializa só os campos relevantes pra comparação num conflito de importação (não o registro inteiro). */
function serializeParaComparacao(associado) {
  return {
    nome: associado.nome,
    telefone: associado.telefone,
    razao_social: associado.razaoSocial,
    nome_fantasia: associado.nomeFantasia,
    cep: associado.cep,
    endereco: associado.endereco,
    numero: associado.numero,
    complemento: associado.complemento,
    bairro: associado.bairro,
    cidade: associado.cidade,
    uf: associado.uf,
    celular: associado.celular,
    email_cadastro: associado.emailCadastro,
  };
}

function serializeLinhaCsvParaResposta(linhaNumero, registro) {
  return {
    linha: linhaNumero,
    cpf_cnpj: registro.cpfCnpj,
    razao_social: registro.razaoSocial ?? null,
    nome_fantasia: registro.nomeFantasia ?? null,
    cep: registro.cep ?? null,
    endereco: registro.endereco ?? null,
    numero: registro.numero ?? null,
    complemento: registro.complemento ?? null,
    bairro: registro.bairro ?? null,
    cidade: registro.cidade ?? null,
    uf: registro.uf ?? null,
    celular: registro.celular ?? null,
    email_cadastro: registro.emailCadastro ?? null,
  };
}

/**
 * POST /api/associados/importar
 * multipart/form-data, campo "arquivo" (CSV, exportação de contatos do
 * Bling — ver mapeamento em MAPA_CABECALHOS).
 *
 * SÓ LEITURA — não escreve nada no banco. Faz o parse, casa cada linha com
 * o cabeçalho, valida CNPJ/CPF (obrigatório; precisa ter 11 ou 14 dígitos —
 * sem isso, "erro", nunca tenta adivinhar) e verifica se cada CNPJ/CPF já
 * existe na franquia atual, devolvendo tudo categorizado pro frontend
 * decidir o próximo passo:
 *   - "novos": CNPJ/CPF que não existe ainda — serão criados automaticamente
 *     em POST /api/associados/importar/aplicar, sem precisar de decisão por
 *     linha (só os CONFLITOS exigem decisão, conforme o brief).
 *   - "conflitos": CNPJ/CPF já cadastrado — traz "atual" (o que já está no
 *     banco) e "importado" (o que veio no CSV) lado a lado, pro frontend
 *     perguntar "atualizar" ou "pular" PRA CADA UM (nunca em massa).
 *   - "erros": linha sem CNPJ/CPF válido — motivo explicado, nunca incluída
 *     em "novos" nem "conflitos".
 *
 * Cada linha de "novos"/"conflitos" já vem com TODOS os campos mapeados
 * (não só o diff) — o frontend guarda esse retorno em memória e reenvia
 * integralmente pra /aplicar (este endpoint não guarda nenhum estado entre
 * as duas chamadas, nem precisa que o arquivo seja reenviado).
 */
exports.importarPreview = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Envie o CSV no campo "arquivo" (multipart/form-data).' });
    }

    const texto = decodificarCsv(req.file.buffer);
    const delimitador = detectarDelimitador(texto);
    const linhas = parseCsv(texto, delimitador);

    if (linhas.length === 0) {
      return res.status(400).json({ error: 'CSV vazio.' });
    }

    const [linhaCabecalho, ...linhasDados] = linhas;
    const { mapeamento, indiceColunaCelular, indiceColunaFone } = mapearCabecalho(linhaCabecalho);

    const temColunaCpfCnpj = mapeamento.some((info) => info && info.campo === 'cpfCnpj');
    if (!temColunaCpfCnpj) {
      return res.status(400).json({
        error: 'CSV não tem uma coluna reconhecível de CNPJ/CPF (esperado um cabeçalho como "CNPJ / CPF").',
      });
    }

    const candidatos = []; // { linhaNumero, registro }
    const erros = [];

    linhasDados.forEach((colunasLinha, indice) => {
      const linhaNumero = indice + 2; // +1 (0-index) +1 (linha 1 = cabeçalho)
      const registro = montarLinha(colunasLinha, mapeamento, indiceColunaCelular, indiceColunaFone);
      const cpfCnpjBruto = (registro.cpfCnpj || '').trim();
      const digitos = apenasDigitos(cpfCnpjBruto);

      if (cpfCnpjBruto === '') {
        erros.push({ linha: linhaNumero, motivo: 'CNPJ/CPF ausente.' });
        return;
      }
      if (digitos.length !== 11 && digitos.length !== 14) {
        erros.push({
          linha: linhaNumero,
          motivo: `CNPJ/CPF inválido ("${cpfCnpjBruto}") — esperado 11 dígitos (CPF) ou 14 (CNPJ), encontrado ${digitos.length}.`,
        });
        return;
      }

      candidatos.push({ linhaNumero, registro: { ...registro, cpfCnpj: cpfCnpjBruto }, digitos });
    });

    // Batch — uma consulta só pra achar todos os CNPJ/CPF já existentes
    // nesta franquia, em vez de N consultas (uma por linha). Correção
    // pós-AJUSTE 19: casa por "cpfCnpjDigits" (só dígitos), não pelo valor
    // exato de "cpf_cnpj" — uma planilha com formatação diferente (com ou
    // sem pontuação) do que já está cadastrado precisa cair em "conflitos",
    // nunca em "novos" só por causa da pontuação.
    const digitosCandidatos = candidatos.map((c) => c.digitos);
    const existentes =
      digitosCandidatos.length > 0
        ? await req.prisma.associado.findMany({ where: { cpfCnpjDigits: { in: digitosCandidatos } } })
        : [];
    const existentePorDigitos = new Map(existentes.map((a) => [a.cpfCnpjDigits, a]));

    const novos = [];
    const conflitos = [];

    for (const { linhaNumero, registro, digitos } of candidatos) {
      const existente = existentePorDigitos.get(digitos);
      if (!existente) {
        novos.push(serializeLinhaCsvParaResposta(linhaNumero, registro));
      } else {
        conflitos.push({
          ...serializeLinhaCsvParaResposta(linhaNumero, registro),
          atual: serializeParaComparacao(existente),
        });
      }
    }

    res.json({
      total_linhas: linhasDados.length,
      delimitador_detectado: delimitador,
      novos,
      conflitos,
      erros,
    });
  } catch (err) {
    next(err);
  }
};

/** Extrai só os campos mapeáveis do CSV de um objeto vindo do body (snake_case, mesmo formato devolvido por importarPreview). */
function extrairCamposDoBody(obj) {
  return {
    cpfCnpj: typeof obj.cpf_cnpj === 'string' ? obj.cpf_cnpj.trim() : '',
    razaoSocial: obj.razao_social || null,
    nomeFantasia: obj.nome_fantasia || null,
    cep: obj.cep || null,
    endereco: obj.endereco || null,
    numero: obj.numero || null,
    complemento: obj.complemento || null,
    bairro: obj.bairro || null,
    cidade: obj.cidade || null,
    uf: obj.uf || null,
    celular: obj.celular || null,
    emailCadastro: obj.email_cadastro || null,
  };
}

/**
 * POST /api/associados/importar/aplicar
 * Body: { "novos": [...], "decisoes": [{ ..., "acao": "atualizar"|"pular" }] }
 *
 * Aplica de verdade — chamado depois que o usuário já viu o preview de
 * POST /api/associados/importar e decidiu (por linha) o que fazer com cada
 * conflito. "novos" é sempre criado (não exige decisão — só os conflitos
 * exigem, conforme o brief). Cada linha é processada de forma independente
 * (uma falha numa linha — ex.: CNPJ/CPF que virou conflito de OUTRA
 * franquia entre o preview e agora — não derruba as demais; reportada em
 * "erros").
 *
 * Cria/atualiza via `upsert` (idempotente — reenviar a mesma linha 2x não
 * duplica nem dá erro). Em CREATE (linha de "novos", ou uma "atualizar" cujo
 * CNPJ/CPF sumiu entre o preview e agora), como "nome"/"telefone" são
 * obrigatórios no schema: nome = Razão Social || Nome Fantasia || CNPJ/CPF;
 * telefone = Celular || "" (mesmo fallback de POST /api/cadastros).
 */
exports.importarAplicar = async (req, res, next) => {
  try {
    const { novos, decisoes } = req.body || {};
    const listaNovos = Array.isArray(novos) ? novos : [];
    const listaDecisoes = Array.isArray(decisoes) ? decisoes : [];

    let criados = 0;
    let atualizados = 0;
    let pulados = 0;
    const erros = [];

    async function aplicarUmRegistro(item, { linha }) {
      const campos = extrairCamposDoBody(item);
      if (!campos.cpfCnpj) {
        erros.push({ linha, cpf_cnpj: item?.cpf_cnpj ?? null, motivo: 'CNPJ/CPF ausente no item enviado.' });
        return;
      }

      const { cpfCnpj, ...camposAssociado } = campos;
      const nomeFallback = campos.razaoSocial || campos.nomeFantasia || cpfCnpj;
      const telefoneFallback = campos.celular || '';

      // Correção pós-AJUSTE 19: casa por "cpfCnpjDigits", não pelo valor
      // exato — só usado aqui pra contar criados/atualizados corretamente
      // (o upsert abaixo já casa certo por conta própria, ver
      // executarUpsertEscopado em prismaComEscopo.js).
      const existiaAntes = await req.prisma.associado.findFirst({
        where: { cpfCnpjDigits: apenasDigitos(cpfCnpj) },
        select: { id: true },
      });

      await req.prisma.associado.upsert({
        where: { cpfCnpj },
        create: { cpfCnpj, nome: nomeFallback, telefone: telefoneFallback, ...camposAssociado },
        update: camposAssociado,
      });

      if (existiaAntes) atualizados += 1;
      else criados += 1;
    }

    for (const item of listaNovos) {
      try {
        await aplicarUmRegistro(item, { linha: item?.linha ?? null });
      } catch (err) {
        erros.push({ linha: item?.linha ?? null, cpf_cnpj: item?.cpf_cnpj ?? null, motivo: err.message });
      }
    }

    for (const item of listaDecisoes) {
      if (item?.acao === 'pular') {
        pulados += 1;
        continue;
      }
      if (item?.acao !== 'atualizar') {
        erros.push({ linha: item?.linha ?? null, cpf_cnpj: item?.cpf_cnpj ?? null, motivo: `"acao" inválida (esperado "atualizar" ou "pular").` });
        continue;
      }
      try {
        await aplicarUmRegistro(item, { linha: item?.linha ?? null });
      } catch (err) {
        erros.push({ linha: item?.linha ?? null, cpf_cnpj: item?.cpf_cnpj ?? null, motivo: err.message });
      }
    }

    res.json({ criados, atualizados, pulados, erros });
  } catch (err) {
    next(err);
  }
};

// ---------------------------------------------------------------------
// AJUSTE 20 — Excluir cadastro (individual e em massa)
// ---------------------------------------------------------------------

/**
 * DELETE /api/associados/:cpfCnpj/cadastro
 *
 * Limpa (seta como `null`) só os 22 campos de cadastro do AJUSTE 19 (ver
 * `CAMPOS_CADASTRO` acima) — NUNCA os campos legados (`nome`, `telefone`,
 * `email`, `em_negociacao`, `bloqueado`, `em_juridico` etc.) nem nenhuma
 * outra tabela. O associado continua existindo normalmente pro
 * Dashboard/Jurídico/Taxa de Inadimplência; só some da listagem desta aba
 * (`GET /associados/registro`, ver `filtroTemCadastro` acima), porque essa
 * aba é justamente "quem tem dado de cadastro".
 *
 * `req.prisma.associado.update` já é escopado por franquia pela extension
 * (`prismaComEscopo.js` — `garantirRegistroDaFranquia` antes do update, lança
 * P2025/404 se o CPF/CNPJ não existir NESTA franquia), mesmo padrão já usado
 * por `atualizarBloqueio`/`resetarBloqueios` em associados.controller.js —
 * não precisa (nem deveria) filtrar franquia manualmente aqui.
 */
exports.excluirCadastro = async (req, res, next) => {
  try {
    const { cpfCnpj } = req.params;

    const associado = await req.prisma.associado.findUnique({ where: { cpfCnpj } });
    if (!associado) {
      return res.status(404).json({ error: 'Associado não encontrado.' });
    }

    await req.prisma.associado.update({ where: { cpfCnpj }, data: dadosCadastroNulo() });

    res.json({ cpf_cnpj: cpfCnpj, cadastro_excluido: true });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/associados/cadastro/excluir-lote
 * Body: { "cpf_cnpjs": ["...", "..."] }
 *
 * Mesma limpeza de `excluirCadastro`, aplicada a cada CPF/CNPJ da lista.
 * Cada item é processado de forma independente (mesmo padrão de
 * `importarAplicar`) — um CPF/CNPJ que não existe (ou não pertence a esta
 * franquia — `findUnique` escopado devolve `null` do mesmo jeito) não
 * derruba o resto do lote, só entra em "nao_encontrados". Um associado que
 * já está sem cadastro (todos os 22 campos já `null`) é achado normalmente e
 * contado em "excluidos" — limpar `null` pra `null` de novo é inofensivo
 * (idempotente), não é tratado como erro.
 */
exports.excluirCadastroLote = async (req, res, next) => {
  try {
    const { cpf_cnpjs: cpfCnpjs } = req.body || {};
    const lista = Array.isArray(cpfCnpjs)
      ? [...new Set(cpfCnpjs.filter((v) => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()))]
      : [];

    if (lista.length === 0) {
      return res.status(400).json({ error: '"cpf_cnpjs" deve ser uma lista não vazia de CPF/CNPJ.' });
    }

    let excluidos = 0;
    const naoEncontrados = [];

    for (const cpfCnpj of lista) {
      const associado = await req.prisma.associado.findUnique({ where: { cpfCnpj } });
      if (!associado) {
        naoEncontrados.push(cpfCnpj);
        continue;
      }
      await req.prisma.associado.update({ where: { cpfCnpj }, data: dadosCadastroNulo() });
      excluidos += 1;
    }

    res.json({
      total_solicitados: lista.length,
      excluidos,
      nao_encontrados: naoEncontrados,
    });
  } catch (err) {
    next(err);
  }
};

// ---------------------------------------------------------------------
// AJUSTE 21 — Editar cadastro (PATCH parcial)
// ---------------------------------------------------------------------

/** "valorEntrada" -> "valor_entrada" (mesma convenção snake_case usada por serializeAssociado/GET detalhe). */
function camelParaSnake(campo) {
  return campo.replace(/[A-Z]/g, (letra) => `_${letra.toLowerCase()}`);
}

// Só precisa listar os campos que NÃO são texto simples — qualquer coisa de
// `CAMPOS_CADASTRO` que não apareça aqui é tratada como 'texto' (textoOuNull)
// por `converterCampo` abaixo. Mantido separado de CAMPOS_CADASTRO (que é a
// lista "quais campos existem", não "como cada um se converte") de propósito
// — CAMPOS_CADASTRO continua sendo reaproveitado tal e qual pelo DELETE.
const TIPO_CAMPO_CADASTRO = {
  valorEntrada: 'decimal',
  dataEntrada: 'data',
  numeroParcelas: 'inteiro',
  valorParcela: 'decimal',
  valorTotal: 'decimal',
  dataVencimento: 'data',
  descontoParcela: 'decimal',
};

/** Converte o valor bruto do body pro tipo esperado do campo — mesmas funções de src/lib/camposCadastro.js usadas por POST /api/cadastros. */
function converterCampo(campo, valorBruto) {
  const tipo = TIPO_CAMPO_CADASTRO[campo] || 'texto';
  switch (tipo) {
    case 'decimal':
      return decimalOuNull(valorBruto);
    case 'data':
      return dataOuNull(valorBruto);
    case 'inteiro':
      return inteiroOuNull(valorBruto);
    default:
      return textoOuNull(valorBruto);
  }
}

/**
 * PATCH /api/associados/:cpfCnpj/cadastro
 * Body: JSON (snake_case, mesmo formato de GET /api/associados/:cpfCnpj) com
 * QUALQUER SUBCONJUNTO dos 22 campos de `CAMPOS_CADASTRO` — nunca exige o
 * payload inteiro. Só atualiza os campos efetivamente PRESENTES no body
 * (checado via hasOwnProperty, não "truthy") — um campo ausente do body
 * nunca é tocado; um campo enviado como `null`/`""` LIMPA aquele campo
 * (mesma semântica de `textoOuNull`/`decimalOuNull`/etc., que já tratam
 * string vazia como null).
 *
 * NÃO toca em nenhum campo legado (`nome`, `telefone`, `email`,
 * `em_negociacao`, `bloqueado`, `em_juridico`) nem em nenhuma outra tabela —
 * mesmo escopo do DELETE (CAMPOS_CADASTRO).
 *
 * Validação: mesma de POST /api/cadastros (`tipo_pessoa` só PF/PJ,
 * `descricao_servico` só as 4 opções válidas), mas só pros campos PRESENTES
 * — nada aqui é obrigatório (edição parcial). Datas inválidas não dão erro,
 * viram `null` silenciosamente — mesmo comportamento de sempre de
 * `dataOuNull`, herdado de POST /api/cadastros.
 *
 * Recálculo de valor_parcela: se `valor_total`, `valor_entrada` ou
 * `numero_parcelas` vierem no body, valor_parcela é recalculado com a mesma
 * fórmula de POST /api/cadastros (`calcularValorParcela`) — os componentes
 * que NÃO vierem no body são lidos do registro atual no banco (pra
 * recalcular certo mesmo editando só um dos três). Se `valor_parcela` vier
 * EXPLICITAMENTE no body, ele tem prioridade e nunca é sobrescrito pelo
 * recálculo (permite ajuste manual pontual, tipo desconto negociado numa
 * parcela específica — inclusive `null` explícito pra limpar).
 */
exports.editarCadastro = async (req, res, next) => {
  try {
    const { cpfCnpj } = req.params;
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    const associado = await req.prisma.associado.findUnique({ where: { cpfCnpj } });
    if (!associado) {
      return res.status(404).json({ error: 'Associado não encontrado.' });
    }

    const data = {};
    for (const campo of CAMPOS_CADASTRO) {
      const chaveSnake = camelParaSnake(campo);
      if (Object.prototype.hasOwnProperty.call(body, chaveSnake)) {
        data[campo] = converterCampo(campo, body[chaveSnake]);
      }
    }

    // Validação (só dos campos presentes e não-nulos — nada é obrigatório).
    if (Object.prototype.hasOwnProperty.call(data, 'tipoPessoa') && data.tipoPessoa !== null) {
      if (!TIPOS_PESSOA_VALIDOS.includes(data.tipoPessoa)) {
        return res.status(400).json({ error: `"tipo_pessoa" inválido (esperado ${TIPOS_PESSOA_VALIDOS.join(' ou ')}).` });
      }
    }
    if (Object.prototype.hasOwnProperty.call(data, 'descricaoServico') && data.descricaoServico !== null) {
      if (!DESCRICOES_SERVICO_VALIDAS.includes(data.descricaoServico)) {
        return res.status(400).json({ error: `"descricao_servico" inválido (esperado um de: ${DESCRICOES_SERVICO_VALIDAS.join(', ')}).` });
      }
    }

    // Recálculo de valor_parcela — só quando algum dos 3 componentes veio no
    // body E valor_parcela em si NÃO veio explicitamente (explícito sempre
    // vence). Componentes ausentes do body são lidos do registro atual.
    const tocouComponentesDaParcela =
      Object.prototype.hasOwnProperty.call(data, 'valorTotal') ||
      Object.prototype.hasOwnProperty.call(data, 'valorEntrada') ||
      Object.prototype.hasOwnProperty.call(data, 'numeroParcelas');
    const valorParcelaExplicito = Object.prototype.hasOwnProperty.call(data, 'valorParcela');

    if (tocouComponentesDaParcela && !valorParcelaExplicito) {
      const valorTotal = Object.prototype.hasOwnProperty.call(data, 'valorTotal')
        ? data.valorTotal
        : decimalPrismaParaNumeroOuNull(associado.valorTotal);
      const valorEntrada = Object.prototype.hasOwnProperty.call(data, 'valorEntrada')
        ? data.valorEntrada
        : decimalPrismaParaNumeroOuNull(associado.valorEntrada);
      const numeroParcelas = Object.prototype.hasOwnProperty.call(data, 'numeroParcelas')
        ? data.numeroParcelas
        : associado.numeroParcelas;

      data.valorParcela = calcularValorParcela({ valorTotal, valorEntrada, numeroParcelas });
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'Nenhum campo de cadastro válido foi enviado.' });
    }

    const atualizado = await req.prisma.associado.update({ where: { cpfCnpj }, data });

    res.json(serializeAssociado(atualizado));
  } catch (err) {
    next(err);
  }
};
