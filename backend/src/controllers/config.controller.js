const prisma = require('../config/prisma');
const cache = require('../services/cache.service');
const {
  getWebhookCadastroUrl,
  setWebhookCadastroUrl,
  getAsaasApiKey,
  setAsaasApiKey,
  getPalavrasExcluidas,
  setPalavrasExcluidas,
  getDiasTolerancia,
  setDiasTolerancia,
} = require('../services/config.service');
const { listarChaves, criarChave, revogarChave } = require('../services/apiKeys.service');

const CARACTERES_VISIVEIS = 6;

/** Mascara a chave, mostrando só os últimos CARACTERES_VISIVEIS caracteres. */
function mascararChave(chave) {
  if (!chave) return null;
  if (chave.length <= CARACTERES_VISIVEIS) return '•'.repeat(chave.length);
  return '•'.repeat(chave.length - CARACTERES_VISIVEIS) + chave.slice(-CARACTERES_VISIVEIS);
}

/**
 * GET /api/config/api-keys
 * Lista todas as API keys cadastradas (ativas e revogadas), mais recentes
 * primeiro, sempre mascaradas (nunca em texto puro). Ver
 * src/services/apiKeys.service.js — inclui a importação automática da
 * antiga chave única na primeira chamada, se a lista ainda estiver vazia.
 */
exports.listarApiKeys = async (req, res, next) => {
  try {
    const chaves = await listarChaves();
    res.json(chaves);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/config/api-keys
 * Body: { "nome": "n8n - Sync Cobrança" }
 * Gera uma nova API key aleatória forte com o nome/rótulo informado e
 * retorna a chave completa — única vez que ela aparece por inteiro na
 * resposta de qualquer endpoint. Não afeta as demais chaves já cadastradas.
 */
exports.criarApiKey = async (req, res, next) => {
  try {
    const { nome } = req.body || {};

    if (typeof nome !== 'string' || nome.trim() === '') {
      return res.status(400).json({ error: '"nome" é obrigatório.' });
    }

    const nova = await criarChave(nome.trim());
    res.status(201).json({
      ...nova,
      aviso: 'Guarde esta chave agora — ela não será exibida completa novamente.',
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/config/api-keys/:id/revogar
 * Revoga individualmente a chave indicada (não deleta, só marca
 * "revogada_em") — deixa de ser aceita por src/middleware/auth.js, sem
 * afetar as demais chaves ativas. Idempotente: revogar uma chave já
 * revogada não é erro. 404 se o id não existir.
 */
exports.revogarApiKey = async (req, res, next) => {
  try {
    const { id } = req.params;
    const revogada = await revogarChave(id);

    if (!revogada) {
      return res.status(404).json({ error: 'Chave não encontrada.' });
    }

    res.json(revogada);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/config/webhook-cadastro
 * Retorna a URL vigente do webhook do n8n usada por POST /api/cadastros
 * (fluxo de Cadastro/Faturamento). `n8n_webhook_cadastro_url: null` quando
 * ainda não foi configurada.
 */
exports.obterWebhookCadastro = async (req, res, next) => {
  try {
    const url = await getWebhookCadastroUrl();
    res.json({ n8n_webhook_cadastro_url: url });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/config/webhook-cadastro
 * Body: { "n8n_webhook_cadastro_url": "https://..." }
 * Atualiza (cria ou substitui) a URL do webhook do n8n na tabela "configuracoes".
 */
exports.atualizarWebhookCadastro = async (req, res, next) => {
  try {
    const { n8n_webhook_cadastro_url: url } = req.body || {};

    if (typeof url !== 'string' || url.trim() === '') {
      return res.status(400).json({ error: '"n8n_webhook_cadastro_url" é obrigatório.' });
    }

    const urlSalva = await setWebhookCadastroUrl(url.trim());
    res.json({ n8n_webhook_cadastro_url: urlSalva });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/config/asaas-key
 * Retorna a chave de API do Asaas vigente mascarada (só os últimos 6
 * caracteres visíveis) — usada pela integração de Taxa de Inadimplência
 * (ver src/services/asaas.service.js). `asaas_api_key: null` quando ainda
 * não foi configurada.
 */
exports.obterAsaasKey = async (req, res, next) => {
  try {
    const chaveAtual = await getAsaasApiKey();
    res.json({ asaas_api_key: mascararChave(chaveAtual) });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/config/asaas-key
 * Body: { "chave": "$aact_..." }
 * Salva (cria ou substitui) a chave de API do Asaas na tabela
 * "configuracoes". Nunca ecoa o valor completo enviado de volta na
 * resposta — só a versão mascarada, mesmo tratamento de GET.
 */
exports.atualizarAsaasKey = async (req, res, next) => {
  try {
    const { chave } = req.body || {};

    if (typeof chave !== 'string' || chave.trim() === '') {
      return res.status(400).json({ error: '"chave" é obrigatório.' });
    }

    await setAsaasApiKey(chave.trim());
    res.json({ asaas_api_key: mascararChave(chave.trim()) });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/config/palavras-excluidas
 * Retorna a lista atual de palavras-chave usadas para excluir
 * automaticamente cobranças do cálculo de Taxa de Inadimplência (ver
 * GET /api/inadimplencia/resumo) — array vazio quando nunca configurada.
 */
exports.obterPalavrasExcluidas = async (req, res, next) => {
  try {
    const palavras = await getPalavrasExcluidas();
    res.json({ palavras });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/config/palavras-excluidas
 * Body: { "palavras": ["palavra1", "palavra2"] }
 * Substitui a lista inteira (não faz merge com a lista anterior). Limpa o
 * cache de /api/inadimplencia/resumo e /evolucao-mensal, para a mudança
 * valer imediatamente na próxima consulta.
 */
exports.atualizarPalavrasExcluidas = async (req, res, next) => {
  try {
    const { palavras } = req.body || {};

    if (!Array.isArray(palavras) || !palavras.every((p) => typeof p === 'string')) {
      return res.status(400).json({ error: '"palavras" deve ser um array de strings.' });
    }

    const salvas = await setPalavrasExcluidas(palavras);
    cache.clear();
    res.json({ palavras: salvas });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/config/tolerancia-dias
 * Retorna o período de tolerância (dias corridos) vigente para a
 * classificação de inadimplência (ver GET /api/inadimplencia/resumo e
 * /evolucao-mensal) — `0` (padrão, nenhuma tolerância) quando nunca
 * configurado.
 */
exports.obterToleranciaDias = async (req, res, next) => {
  try {
    const dias = await getDiasTolerancia();
    res.json({ dias });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/config/tolerancia-dias
 * Body: { "dias": number }
 * Valida que "dias" é um inteiro entre 0 e 30 (dias corridos), salva na
 * tabela "configuracoes" e limpa o cache de /api/inadimplencia/resumo e
 * /evolucao-mensal — a mudança vale já na próxima consulta, sem esperar o
 * TTL de 4 minutos expirar (mesmo tratamento já dado a
 * exclusões/palavras-excluidas).
 */
exports.atualizarToleranciaDias = async (req, res, next) => {
  try {
    const { dias } = req.body || {};

    if (!Number.isInteger(dias) || dias < 0 || dias > 30) {
      return res.status(400).json({ error: '"dias" deve ser um número inteiro entre 0 e 30.' });
    }

    const salvo = await setDiasTolerancia(dias);
    cache.clear();
    res.json({ dias: salvo });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/config/sync-log
 * Retorna as últimas 20 execuções de POST /api/sync, mais recentes primeiro.
 */
exports.syncLog = async (req, res, next) => {
  try {
    const logs = await prisma.syncLog.findMany({
      orderBy: { executadoEm: 'desc' },
      take: 20,
    });

    res.json(
      logs.map((log) => ({
        id: log.id,
        executado_em: log.executadoEm,
        total_associados_processados: log.totalAssociadosProcessados,
        sucesso: log.sucesso,
      }))
    );
  } catch (err) {
    next(err);
  }
};
