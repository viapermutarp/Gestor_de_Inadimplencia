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

/**
 * Busca o cliente do Asaas pelo CPF/CNPJ (usado para popular
 * Associado.nomeAsaas — ver AJUSTE 9), via GET /v3/customers?cpfCnpj=...
 * (a API de clientes aceita busca por cpfCnpj, com ou sem formatação; aqui
 * sempre enviamos só dígitos, mesma normalização usada no matching de
 * exclusões). Retorna o campo "name" tal como veio do Asaas, VERBATIM (sem
 * nenhum parsing/tratamento — inclui o prefixo numérico que o Asaas usa,
 * ex: "45.493.621 ERICA DA COSTA ROSA"), ou null se não encontrar nenhum
 * cliente com esse documento (removido do Asaas, documento divergente,
 * etc.) — nunca lança nesse caso, só em falha de rede/autenticação (deixa a
 * AsaasApiError subir pra quem chamou decidir como tratar).
 */
async function buscarClientePorCpfCnpj(cpfCnpj, franquiaId) {
  const documento = (cpfCnpj || '').replace(/\D/g, '');
  if (!documento) return null;

  const pagina = await requisitar('/customers', { cpfCnpj: documento, limit: 2 }, franquiaId);
  const clientes = Array.isArray(pagina.data) ? pagina.data : [];
  if (clientes.length === 0) return null;

  return clientes[0].name || null;
}

/**
 * Investigação "cobranças removidas no Asaas" (setembro/2026) — busca UM
 * pagamento específico pelo id ("pay_..."), via GET /v3/payments/{id}, pra
 * CONFIRMAR na fonte de verdade se ele foi removido no Asaas, distinto de
 * "nunca existiu" ou "ainda existe sob outro status". Motivo de existir:
 * quando o Asaas apaga uma cobrança (evento PAYMENT_DELETED), a linha
 * correspondente é REMOVIDA por inteiro de `pagamentos_asaas`
 * (`excluirPagamento`, `pagamentosAsaas.service.js`) — não sobra nenhum
 * status local "deletado" pra comparar, então uma `Cobranca` local
 * pending/overdue cujo id_externo não bate com nada em `pagamentos_asaas`
 * é AMBÍGUA só por comparação local (ver
 * `scripts/diagnostico-cobrancas-removidas-asaas.js`, primeiro consumidor,
 * e futuramente o webhook `PAYMENT_DELETED`/job de reconciliação diária,
 * que precisam da mesma confirmação antes de marcar `Cobranca.status =
 * "removida"` — nunca só pela ausência local).
 *
 * Diferente de `requisitar` (usada pelas demais funções deste módulo), esta
 * função trata 404 como uma resposta VÁLIDA (id nunca existiu nesta conta),
 * não uma falha — por isso não deixa a `AsaasApiError` de 404 subir crua;
 * qualquer outro erro (401/timeout/5xx) continua subindo normalmente.
 *
 * A API do Asaas continua respondendo 200 com o pagamento (campo
 * `"deleted": true`) para um id que já foi excluído — só um 404 de verdade
 * significa "nunca existiu nesta conta". Retorna:
 *   - `{ existe: false }` — 404.
 *   - `{ existe: true, deletado: boolean, pagamento: {...} }` — 200,
 *     `pagamento` é o objeto cru do Asaas (mesmos campos de
 *     `listarPagamentos`/webhook: id/customer/value/dueDate/paymentDate/
 *     status/description/deleted).
 */
async function buscarPagamentoPorId(id, franquiaId) {
  try {
    const pagamento = await requisitar(`/payments/${id}`, {}, franquiaId);
    return { existe: true, deletado: pagamento.deleted === true, pagamento };
  } catch (err) {
    // "requisitar" não expõe o status HTTP real do Asaas em "err.status"
    // (sempre 502 pra qualquer coisa != 401 — ver implementação acima) — o
    // status real do Asaas vem embutido na MENSAGEM
    // ("...respondeu com status ${resposta.status}..."). Só 404 é tratado
    // aqui como resposta válida; qualquer outro texto/erro sobe intacto.
    if (err instanceof AsaasApiError && /respondeu com status 404\b/.test(err.message)) {
      return { existe: false };
    }
    throw err;
  }
}

module.exports = {
  listarPagamentos,
  obterClientesPorId,
  buscarClientePorCpfCnpj,
  buscarPagamentoPorId,
  AsaasApiError,
  ASAAS_BASE_URL,
};
