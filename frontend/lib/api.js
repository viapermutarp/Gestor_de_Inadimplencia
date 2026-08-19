import { getToken, clearToken } from "./auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request(path, { method = "GET", body, auth = true } = {}) {
  if (!API_URL) {
    throw new ApiError(
      "NEXT_PUBLIC_API_URL não está configurada. Defina a URL da API no .env.local.",
      0
    );
  }

  const headers = { "Content-Type": "application/json" };

  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let res;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("Não foi possível conectar à API. Verifique sua conexão.", 0);
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    if (res.status === 401 && auth) clearToken();
    throw new ApiError(data?.error || `Erro na requisição (${res.status}).`, res.status);
  }

  return data;
}

export function login(usuario, senha) {
  return request("/api/login", { method: "POST", body: { usuario, senha }, auth: false });
}

/**
 * GET /api/associados — resposta paginada: { dados: [...], paginacao: {...} }.
 *
 * Aceita os filtros/parametros suportados pelo backend, todos opcionais:
 *   { emNegociacao, bloqueado, emJuridico, busca, page, limit }
 * `emNegociacao`/`bloqueado`/`emJuridico` são booleanos (só entram na query
 * quando `true`; omitir = sem esse filtro). `busca` pesquisa por nome,
 * cpf_cnpj ou telefone (contains, case-insensitive) — feito no backend.
 */
export function getAssociados({
  emNegociacao,
  bloqueado,
  emJuridico,
  busca,
  page,
  limit,
} = {}) {
  const params = new URLSearchParams();
  if (emNegociacao !== undefined) params.set("em_negociacao", String(emNegociacao));
  if (bloqueado !== undefined) params.set("bloqueado", String(bloqueado));
  if (emJuridico !== undefined) params.set("em_juridico", String(emJuridico));
  if (busca) params.set("busca", busca);
  if (page !== undefined) params.set("page", String(page));
  if (limit !== undefined) params.set("limit", String(limit));

  const query = params.toString();
  return request(`/api/associados${query ? `?${query}` : ""}`);
}

/**
 * GET /api/associados/resumo — números agregados calculados no banco
 * (com_cobranca_aberto, valor_total_aberto, em_negociacao, bloqueados,
 * em_juridico). Só aceita `busca` (não os filtros booleanos, nem
 * paginação — a resposta já é só um objeto de números).
 */
export function getResumo({ busca } = {}) {
  const params = new URLSearchParams();
  if (busca) params.set("busca", busca);

  const query = params.toString();
  return request(`/api/associados/resumo${query ? `?${query}` : ""}`);
}

export function getAssociadoDetalhe(cpfCnpj) {
  return request(`/api/associados/${encodeURIComponent(cpfCnpj)}`);
}

export function patchNegociacao(cpfCnpj, payload) {
  return request(`/api/associados/${encodeURIComponent(cpfCnpj)}/negociacao`, {
    method: "PATCH",
    body: payload,
  });
}

export function patchBloqueio(cpfCnpj, payload) {
  return request(`/api/associados/${encodeURIComponent(cpfCnpj)}/bloqueio`, {
    method: "PATCH",
    body: payload,
  });
}

export function patchJuridico(cpfCnpj, payload) {
  return request(`/api/associados/${encodeURIComponent(cpfCnpj)}/juridico`, {
    method: "PATCH",
    body: payload,
  });
}

export function getBloqueiosContador(cpfCnpj) {
  return request(`/api/associados/${encodeURIComponent(cpfCnpj)}/bloqueios/contador`);
}

export function resetarBloqueios(cpfCnpj) {
  return request(`/api/associados/${encodeURIComponent(cpfCnpj)}/bloqueios/resetar`, {
    method: "POST",
  });
}

export function getApiKeyMascarada() {
  return request("/api/config/api-key");
}

export function regenerarApiKey() {
  return request("/api/config/api-key/regenerar", { method: "POST" });
}

export function getSyncLog() {
  return request("/api/config/sync-log");
}

/**
 * POST /api/cadastros — fluxo de Cadastro/Faturamento (substitui o gatilho
 * do Kommo). O payload usa chaves em português, com acento/espaço, EXATAMENTE
 * como o backend espera (ex.: "Tipo de Pessoa", "Razão Social", "CNPJ/CPF",
 * "Descrição do Serviço" etc.) — ver app/cadastro/page.js para o formato
 * completo. Sempre retorna 201 em caso de payload válido (mesmo que o
 * repasse ao n8n falhe); erro de validação vem como 400.
 */
export function criarCadastro(payload) {
  return request("/api/cadastros", { method: "POST", body: payload });
}

/**
 * GET /api/inadimplencia/resumo — números da tela de Taxa de Inadimplência,
 * calculados em tempo real a partir da API do Asaas (pode demorar alguns
 * segundos). Todos os parâmetros são opcionais: sem `vencDe`/`vencAte`, o
 * backend usa os últimos 12 meses; sem `renegociacao`/`emJuridico`/`bloqueado`,
 * usa "todos" nos três. Esses três aceitam exatamente "todos" | "sim" | "nao".
 * `visaoFaixas` aceita "aberto" (padrão, snapshot de hoje) | "historico"
 * (mesma regra de classificação por data de pagamento usada em
 * `valor_inadimplente`) — controla só `faixas`/`criticos_90_dias`.
 * `forcar: true` ignora o cache do backend para ESTA chamada (sempre busca
 * dados frescos do Asaas), mas o resultado novo ainda fica cacheado lá para
 * as chamadas seguintes — usado pelo botão "Atualizar" da tela.
 *
 * Se a chave de API do Asaas não estiver configurada, o backend responde
 * 400 com uma mensagem citando "asaas-key" — ver tratamento em
 * app/inadimplencia/page.js.
 */
export function getResumoInadimplencia({ vencDe, vencAte, renegociacao, emJuridico, bloqueado, visaoFaixas, forcar } = {}) {
  const params = new URLSearchParams();
  if (vencDe) params.set("venc_de", vencDe);
  if (vencAte) params.set("venc_ate", vencAte);
  if (renegociacao) params.set("renegociacao", renegociacao);
  if (emJuridico) params.set("em_juridico", emJuridico);
  if (bloqueado) params.set("bloqueado", bloqueado);
  if (visaoFaixas) params.set("visao_faixas", visaoFaixas);
  if (forcar) params.set("forcar", "true");

  const query = params.toString();
  return request(`/api/inadimplencia/resumo${query ? `?${query}` : ""}`);
}

/**
 * GET /api/inadimplencia/evolucao-mensal — mesmos números do /resumo
 * (valor_total_faturado, valor_inadimplente, taxa_inadimplencia_percentual),
 * mais taxa_adimplencia_percentual, agrupados por mês ("YYYY-MM"). Mesmos
 * parâmetros de filtro do /resumo (`renegociacao`/`emJuridico`/`bloqueado`,
 * `forcar`), mas não aceita `visaoFaixas` (esse endpoint não devolve faixas).
 */
export function getEvolucaoMensal({ vencDe, vencAte, renegociacao, emJuridico, bloqueado, forcar } = {}) {
  const params = new URLSearchParams();
  if (vencDe) params.set("venc_de", vencDe);
  if (vencAte) params.set("venc_ate", vencAte);
  if (renegociacao) params.set("renegociacao", renegociacao);
  if (emJuridico) params.set("em_juridico", emJuridico);
  if (bloqueado) params.set("bloqueado", bloqueado);
  if (forcar) params.set("forcar", "true");

  const query = params.toString();
  return request(`/api/inadimplencia/evolucao-mensal${query ? `?${query}` : ""}`);
}

export function getAsaasKeyMascarada() {
  return request("/api/config/asaas-key");
}

/** PATCH /api/config/asaas-key — body { chave }. Retorna só a versão mascarada. */
export function atualizarAsaasKey(chave) {
  return request("/api/config/asaas-key", { method: "PATCH", body: { chave } });
}

/**
 * GET /api/config/palavras-excluidas — { palavras: string[] } usadas para
 * excluir automaticamente cobranças do cálculo de Taxa de Inadimplência
 * pela descrição (contains, case-insensitive).
 */
export function getPalavrasExcluidas() {
  return request("/api/config/palavras-excluidas");
}

/** PATCH /api/config/palavras-excluidas — body { palavras }. Substitui a lista inteira. */
export function atualizarPalavrasExcluidas(palavras) {
  return request("/api/config/palavras-excluidas", { method: "PATCH", body: { palavras } });
}

/**
 * GET /api/config/tolerancia-dias — { dias: number }, período de tolerância
 * (dias corridos) aplicado à classificação ADIMPLENTE x INADIMPLENTE da
 * Taxa de Inadimplência (ver GET /api/inadimplencia/resumo e
 * evolucao-mensal). `0` (padrão) quando nunca configurado.
 */
export function getToleranciaDias() {
  return request("/api/config/tolerancia-dias");
}

/** PATCH /api/config/tolerancia-dias — body { dias }. Inteiro entre 0 e 30. */
export function atualizarToleranciaDias(dias) {
  return request("/api/config/tolerancia-dias", { method: "PATCH", body: { dias } });
}

/** GET /api/inadimplencia/exclusoes — lista as exclusões manuais cadastradas. */
export function getExclusoes() {
  return request("/api/inadimplencia/exclusoes");
}

/** POST /api/inadimplencia/exclusoes — body { asaas_payment_id, motivo? }. */
export function criarExclusao({ asaasPaymentId, motivo }) {
  return request("/api/inadimplencia/exclusoes", {
    method: "POST",
    body: { asaas_payment_id: asaasPaymentId, motivo: motivo || undefined },
  });
}

/** DELETE /api/inadimplencia/exclusoes/:id */
export function removerExclusao(id) {
  return request(`/api/inadimplencia/exclusoes/${encodeURIComponent(id)}`, { method: "DELETE" });
}
