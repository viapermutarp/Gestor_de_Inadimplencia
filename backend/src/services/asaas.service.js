const { getAsaasApiKey } = require('./config.service');

// Permite apontar para um mock em testes (ver README/testes) sem tocar na
// URL real da API do Asaas. Em produção, sempre
// "https://www.asaas.com/api/v3" (padrão).
const ASAAS_BASE_URL = process.env.ASAAS_API_BASE_URL || 'https://www.asaas.com/api/v3';

const LIMITE_PAGINACAO = 100;
const TIMEOUT_MS = 15000;
const CONCORRENCIA_CLIENTES = 5;

class AsaasApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'AsaasApiError';
    this.status = status;
  }
}

async function requisitar(caminho, params = {}, franquiaId) {
  const chave = await getAsaasApiKey(franquiaId);

  if (!chave) {
    throw new AsaasApiError(
      'Chave da API do Asaas não configurada. Configure em PATCH /api/config/asaas-key.',
      400
    );
  }

  const url = new URL(`${ASAAS_BASE_URL}${caminho}`);
  for (const [nome, valor] of Object.entries(params)) {
    if (valor !== undefined && valor !== null) url.searchParams.set(nome, String(valor));
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let resposta;
  try {
    resposta = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'GestorInadimplencia-ViaPermuta/1.0',
        access_token: chave,
      },
      signal: controller.signal,
    });
  } catch (err) {
    const mensagem = err.name === 'AbortError' ? 'Tempo esgotado ao consultar a API do Asaas.' : err.message;
    throw new AsaasApiError(`Erro ao consultar a API do Asaas: ${mensagem}`, 502);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!resposta.ok) {
    const corpo = await resposta.text().catch(() => '');
    if (resposta.status === 401) {
      throw new AsaasApiError(
        'Chave da API do Asaas inválida ou expirada. Verifique em PATCH /api/config/asaas-key.',
        400
      );
    }
    throw new AsaasApiError(
      `A API do Asaas respondeu com status ${resposta.status}${corpo ? `: ${corpo.slice(0, 500)}` : ''}`,
      502
    );
  }

  return resposta.json();
}

/**
 * Busca TODOS os pagamentos (qualquer status) com vencimento dentro do
 * intervalo [dueDateGe, dueDateLe] (strings "YYYY-MM-DD"), paginando pelo
 * mesmo esquema offset/limit da API do Asaas (limit máximo 100 por página;
 * `hasMore` indica se há mais uma página) até esgotar os resultados.
 */
async function listarPagamentos({ dueDateGe, dueDateLe }, franquiaId) {
  const pagamentos = [];
  let offset = 0;

  for (;;) {
    const pagina = await requisitar(
      '/payments',
      {
        'dueDate[ge]': dueDateGe,
        'dueDate[le]': dueDateLe,
        limit: LIMITE_PAGINACAO,
        offset,
      },
      franquiaId
    );

    const dados = Array.isArray(pagina.data) ? pagina.data : [];
    pagamentos.push(...dados);

    if (!pagina.hasMore || dados.length === 0) break;
    offset += LIMITE_PAGINACAO;
  }

  return pagamentos;
}

/**
 * Resolve nome/cpfCnpj de um conjunto de IDs de cliente do Asaas (campo
 * "customer" dos pagamentos — a API de pagamentos não traz o cpfCnpj
 * diretamente, só a referência ao cliente). Faz uma chamada
 * GET /v3/customers/{id} por ID único, com concorrência limitada.
 * IDs que falharem na consulta ficam de fora do Map (tratados como
 * "sem associado correspondente" por quem chama) — uma falha isolada não
 * derruba o cálculo do resumo inteiro.
 */
async function obterClientesPorId(idsClientes, franquiaId) {
  const idsUnicos = [...new Set(idsClientes.filter(Boolean))];
  const porId = new Map();

  let cursor = 0;
  async function worker() {
    for (;;) {
      const indice = cursor++;
      if (indice >= idsUnicos.length) return;
      const id = idsUnicos[indice];
      try {
        const cliente = await requisitar(`/customers/${id}`, {}, franquiaId);
        porId.set(id, { cpfCnpj: cliente.cpfCnpj || null, nome: cliente.name || null });
      } catch (err) {
        console.error(`[asaas] Falha ao resolver cliente ${id}:`, err.message);
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCORRENCIA_CLIENTES, idsUnicos.length) }, worker);
  await Promise.all(workers);

  return porId;
}

module.exports = { listarPagamentos, obterClientesPorId, AsaasApiError, ASAAS_BASE_URL };
