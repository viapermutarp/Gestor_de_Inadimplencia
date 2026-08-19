const prisma = require('../config/prisma');
const { getWebhookCadastroUrl } = require('../services/config.service');

const LIMITE_PADRAO = 100;
const LIMITE_MAXIMO = 100;
const TIMEOUT_N8N_MS = 10000;

const DESCRICOES_SERVICO_VALIDAS = [
  'Anuidade (PIX)',
  'Anuidade (Boleto)',
  'Anuidade (Cartão de Crédito)',
  'Recorrência Cartão de Crédito (Anuidade)',
];

const TIPOS_PESSOA_VALIDOS = ['PF', 'PJ'];

function campoPreenchido(valor) {
  return typeof valor === 'string' && valor.trim() !== '';
}

/**
 * Valida os campos obrigatórios do payload de POST /api/cadastros:
 * "CNPJ/CPF", ("Razão Social" OU "Contato"), "Descrição do Serviço" e
 * "Valor Total". Também valida os dois campos de valor fechado (enum)
 * quando presentes ("Descrição do Serviço" é obrigatório e precisa bater
 * com uma das opções; "Tipo de Pessoa" é opcional, mas se vier tem que ser
 * "PF" ou "PJ"). Retorna um array de mensagens de erro (vazio = válido).
 */
function validarPayload(payload) {
  const erros = [];

  if (!campoPreenchido(payload['CNPJ/CPF'])) {
    erros.push('"CNPJ/CPF" é obrigatório.');
  }

  if (!campoPreenchido(payload['Razão Social']) && !campoPreenchido(payload['Contato'])) {
    erros.push('Informe "Razão Social" ou "Contato".');
  }

  if (!campoPreenchido(payload['Descrição do Serviço'])) {
    erros.push('"Descrição do Serviço" é obrigatório.');
  } else if (!DESCRICOES_SERVICO_VALIDAS.includes(payload['Descrição do Serviço'])) {
    erros.push(
      `"Descrição do Serviço" deve ser uma das opções: ${DESCRICOES_SERVICO_VALIDAS.join(', ')}.`
    );
  }

  if (!campoPreenchido(payload['Valor Total'])) {
    erros.push('"Valor Total" é obrigatório.');
  }

  if (payload['Tipo de Pessoa'] !== undefined && !TIPOS_PESSOA_VALIDOS.includes(payload['Tipo de Pessoa'])) {
    erros.push('"Tipo de Pessoa" deve ser "PF" ou "PJ".');
  }

  return erros;
}

/**
 * Repassa o payload para o webhook do n8n configurado (n8n_webhook_cadastro_url).
 * Nunca lança: sempre retorna { ok, erro? } — falha de rede/timeout/HTTP não
 * deve travar a resposta de POST /api/cadastros, só é registrada no banco.
 */
async function enviarParaN8n(payload) {
  const url = await getWebhookCadastroUrl();

  if (!url) {
    return { ok: false, erro: 'URL do webhook do n8n (n8n_webhook_cadastro_url) não está configurada.' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_N8N_MS);

  try {
    const resposta = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!resposta.ok) {
      const corpo = await resposta.text().catch(() => '');
      return {
        ok: false,
        erro: `n8n respondeu com status ${resposta.status}${corpo ? `: ${corpo.slice(0, 500)}` : ''}`,
      };
    }

    return { ok: true };
  } catch (err) {
    const mensagem = err.name === 'AbortError' ? 'Tempo esgotado ao chamar o webhook do n8n.' : err.message;
    return { ok: false, erro: mensagem };
  } finally {
    clearTimeout(timeoutId);
  }
}

function serializeCadastro(cadastro) {
  return {
    id: cadastro.id,
    payload: cadastro.payload,
    status: cadastro.status,
    resposta_n8n: cadastro.respostaN8n,
    criado_em: cadastro.criadoEm,
  };
}

/**
 * POST /api/cadastros
 *
 * Recebe o payload do formulário de Cadastro/Faturamento (chaves em
 * português, com acento/espaço — mantidas assim porque é o formato que o
 * n8n já espera). Fluxo:
 *   1. Valida os campos obrigatórios (ver `validarPayload`).
 *   2. Salva o registro em "cadastros_enviados" com status "enviado".
 *   3. Tenta repassar o payload ao webhook do n8n configurado.
 *   4. Se o repasse falhar (rede, timeout, HTTP de erro, ou URL não
 *      configurada), atualiza o registro para status "erro" com o motivo em
 *      "resposta_n8n" — mas a resposta HTTP continua sendo de sucesso, já
 *      que o cadastro em si foi salvo. A falha ao chamar o n8n nunca deve
 *      travar o formulário para quem está preenchendo.
 */
exports.criar = async (req, res, next) => {
  try {
    const payload = req.body || {};

    const erros = validarPayload(payload);
    if (erros.length > 0) {
      return res.status(400).json({ error: erros.join(' ') });
    }

    let cadastro = await prisma.cadastroEnviado.create({
      data: { payload, status: 'enviado' },
    });

    const resultadoN8n = await enviarParaN8n(payload);

    if (!resultadoN8n.ok) {
      cadastro = await prisma.cadastroEnviado.update({
        where: { id: cadastro.id },
        data: { status: 'erro', respostaN8n: resultadoN8n.erro },
      });
    }

    res.status(201).json(serializeCadastro(cadastro));
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/cadastros
 * GET /api/cadastros?page=2&limit=50
 *
 * Lista os cadastros enviados, paginado (mesmo padrão de GET /api/associados):
 * "page" (padrão 1) e "limit" (padrão 100, máximo 100). Mais recentes primeiro.
 * Resposta: { dados: [...], paginacao: { pagina_atual, total_paginas, total_registros, por_pagina } }
 */
exports.listar = async (req, res, next) => {
  try {
    const { page: pageParam, limit: limitParam } = req.query;

    let page = parseInt(pageParam, 10);
    if (!Number.isInteger(page) || page < 1) page = 1;

    let limit = parseInt(limitParam, 10);
    if (!Number.isInteger(limit) || limit < 1) limit = LIMITE_PADRAO;
    if (limit > LIMITE_MAXIMO) limit = LIMITE_MAXIMO;

    const totalRegistros = await prisma.cadastroEnviado.count();
    const totalPaginas = Math.max(Math.ceil(totalRegistros / limit), 1);

    const cadastros = await prisma.cadastroEnviado.findMany({
      orderBy: { criadoEm: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });

    res.json({
      dados: cadastros.map(serializeCadastro),
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
