import { getToken, getRefreshToken, setSession, clearToken } from "./auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function fetchJson(path, { method, headers, body, signal }) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  return { res, data };
}

// Garante uma única chamada a POST /api/refresh por vez, mesmo se várias
// chamadas autenticadas levarem 401 (access token vencido) ao mesmo tempo
// — o backend ROTACIONA o refresh token a cada uso (um refresh token só
// funciona uma vez), então duas chamadas concorrentes de refresh
// invalidariam uma à outra se não esperassem a mesma promise. Todo mundo
// que chega aqui enquanto uma renovação já está em andamento espera o
// mesmo resultado em vez de disparar a sua própria.
let renovacaoEmAndamento = null;

async function renovarSessao() {
  if (renovacaoEmAndamento) return renovacaoEmAndamento;

  renovacaoEmAndamento = (async () => {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return false;

    try {
      const { res, data } = await fetchJson("/api/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { refresh_token: refreshToken },
      });
      if (!res.ok || !data?.token) return false;
      setSession({ token: data.token, refreshToken: data.refresh_token });
      return true;
    } catch {
      return false;
    }
  })();

  try {
    return await renovacaoEmAndamento;
  } finally {
    renovacaoEmAndamento = null;
  }
}

/**
 * `permitirRenovacao` controla se um 401 nesta chamada deve disparar uma
 * tentativa de renovação silenciosa via refresh token antes de desistir —
 * fica `false` na segunda tentativa (depois de já ter renovado uma vez)
 * pra nunca entrar em loop, e nas próprias chamadas de /login e /refresh
 * (que não fazem sentido "renovar").
 */
async function request(path, { method = "GET", body, auth = true, timeoutMs, permitirRenovacao = true } = {}) {
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

  // `timeoutMs` é opcional — usado por chamadas que sabidamente podem demorar
  // bem mais que o normal (ex.: dispararSincronizacao, que aguarda um webhook
  // do n8n paginar no Asaas), pra não deixar o fetch pendurado indefinidamente
  // se a rede/servidor travar sem nunca fechar a conexão.
  const controller = timeoutMs ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let res;
  let data;
  try {
    ({ res, data } = await fetchJson(path, { method, headers, body, signal: controller?.signal }));
  } catch (err) {
    if (err.name === "AbortError") {
      throw new ApiError("Tempo esgotado ao aguardar resposta da API.", 0);
    }
    throw new ApiError("Não foi possível conectar à API. Verifique sua conexão.", 0);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  if (!res.ok) {
    // 401 numa chamada autenticada quase sempre é access token vencido
    // (dura poucos minutos por design) — tenta renovar em segundo plano
    // com o refresh token e refazer ESTA MESMA chamada uma única vez,
    // antes de considerar a sessão de fato encerrada. Só desiste (limpa a
    // sessão) se a renovação também falhar (refresh token ausente,
    // expirado ou revogado).
    if (res.status === 401 && auth && permitirRenovacao) {
      const renovou = await renovarSessao();
      if (renovou) {
        return request(path, { method, body, auth, timeoutMs, permitirRenovacao: false });
      }
      clearToken();
    } else if (res.status === 401 && auth) {
      clearToken();
    }
    throw new ApiError(data?.error || `Erro na requisição (${res.status}).`, res.status);
  }

  return data;
}

export function login(usuario, senha) {
  return request("/api/login", { method: "POST", body: { usuario, senha }, auth: false });
}

/** POST /api/logout — revoga a sessão no servidor. Best-effort: quem chama decide o que fazer se falhar (ver AppHeader). */
export function logout() {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return Promise.resolve();
  return request("/api/logout", { method: "POST", body: { refresh_token: refreshToken }, auth: false });
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

/**
 * GET /api/config/api-keys — lista todas as API keys cadastradas (ativas e
 * revogadas), mais recentes primeiro, sempre mascaradas. Cada item:
 * { id, nome, chave_mascarada, criada_em, ultimo_uso_em, ativa }.
 */
export function listarApiKeys() {
  return request("/api/config/api-keys");
}

/**
 * POST /api/config/api-keys — body { nome }. Gera uma nova chave com o
 * nome/rótulo informado (ex.: "n8n - Sync Cobrança") e não afeta as demais
 * chaves já cadastradas. Retorna { id, nome, chave, criada_em, aviso } —
 * "chave" só aparece completa nesta resposta.
 */
export function criarApiKey(nome) {
  return request("/api/config/api-keys", { method: "POST", body: { nome } });
}

/**
 * POST /api/config/api-keys/:id/revogar — revoga só a chave indicada
 * (idempotente); as demais continuam funcionando normalmente.
 */
export function revogarApiKey(id) {
  return request(`/api/config/api-keys/${encodeURIComponent(id)}/revogar`, {
    method: "POST",
  });
}

export function getSyncLog() {
  return request("/api/config/sync-log");
}

/**
 * POST /api/sync/atualizar — dispara sob demanda o webhook do n8n
 * (configurado no backend via N8N_SYNC_WEBHOOK_URL) que sincroniza com o
 * Asaas e já deixa nosso banco atualizado quando responde. Usado pelo botão
 * "Atualizar" do Dashboard: chamado ANTES da re-busca de tabela/cards, para
 * que a re-busca já reflita os dados novos.
 *
 * Timeout de 35s no frontend (um pouco maior que os 30s do backend, pra
 * deixar o backend responder primeiro com sua própria mensagem de timeout
 * em vez do frontend desistir antes). Falhas (502 do backend, timeout, rede)
 * lançam ApiError normalmente — quem chama decide se trava o fluxo ou só
 * avisa e segue com a re-busca normal (ver handleAtualizar em
 * app/dashboard/page.js).
 */
export function dispararSincronizacao() {
  return request("/api/sync/atualizar", { method: "POST", timeoutMs: 35000 });
}

/**
 * POST /api/cadastros — fluxo de Cadastro/Faturamento (substitui o gatilho
 * do Kommo). O payload usa chaves em português, com acento/espaço, EXATAMENTE
 * como o backend espera (ex.: "Tipo de Pessoa", "Razão Social", "CNPJ/CPF",
 * "Descrição do Serviço" etc.) — ver app/cadastro/page.js para o formato
 * completo. Sempre retorna 201 em caso de payload válido (mesmo que o
 * repasse ao n8n falhe); erro de validação vem como 400.
 *
 * Resposta: { id, payload, status: "enviado"|"erro", resposta_n8n,
 * link_pagamento, cliente_asaas_id, pedido_bling_id, criado_em }.
 * "status": "enviado" com "link_pagamento" preenchido é sucesso de verdade
 * (o n8n criou cliente/cobrança); "status": "erro" traz o motivo em
 * "resposta_n8n" (timeout, falha de negócio no n8n, etc.) — ver
 * app/cadastro/page.js pra como isso é exibido.
 *
 * Timeout de 65s no frontend (o backend espera até 60s pelo n8n, que
 * encadeia Bling + Asaas com retries — a folga de 5s deixa o backend
 * responder primeiro com sua própria mensagem de timeout).
 */
export function criarCadastro(payload) {
  return request("/api/cadastros", { method: "POST", body: payload, timeoutMs: 65000 });
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
 * GET /api/config/webhook-cadastro — URL vigente do webhook do n8n usada
 * por POST /api/cadastros (fluxo de Cadastro/Faturamento). Retorna
 * { n8n_webhook_cadastro_url }, null quando ainda não configurada.
 */
export function getWebhookCadastroUrl() {
  return request("/api/config/webhook-cadastro");
}

/** PATCH /api/config/webhook-cadastro — body { n8n_webhook_cadastro_url }. */
export function atualizarWebhookCadastroUrl(url) {
  return request("/api/config/webhook-cadastro", {
    method: "PATCH",
    body: { n8n_webhook_cadastro_url: url },
  });
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

/**
 * GET /api/contratos — lista todos os modelos de contrato (ativos e
 * inativos), mais recentes primeiro. `ativo` (opcional): true|false, pra
 * filtrar — a tela de Cadastro usa `{ ativo: true }` em "Contratos a gerar".
 */
export function listarContratos({ ativo } = {}) {
  const params = new URLSearchParams();
  if (ativo !== undefined) params.set("ativo", String(ativo));
  const query = params.toString();
  return request(`/api/contratos${query ? `?${query}` : ""}`);
}

export function getContrato(id) {
  return request(`/api/contratos/${encodeURIComponent(id)}`);
}

/** POST /api/contratos — body { nome, tipo: "TERMO"|"ADITIVO", conteudo }. */
export function criarContrato({ nome, tipo, conteudo }) {
  return request("/api/contratos", { method: "POST", body: { nome, tipo, conteudo } });
}

/** PATCH /api/contratos/:id — body: qualquer subconjunto de { nome, tipo, conteudo, ativo }. */
export function atualizarContrato(id, dados) {
  return request(`/api/contratos/${encodeURIComponent(id)}`, { method: "PATCH", body: dados });
}

/** DELETE /api/contratos/:id — soft-delete (ativo: false), nunca remove de verdade. */
export function removerContrato(id) {
  return request(`/api/contratos/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * GET /api/config/drive-pasta-raiz — { drive_pasta_raiz_id }, null quando
 * ainda não configurada.
 */
export function getDrivePastaRaiz() {
  return request("/api/config/drive-pasta-raiz");
}

/** PATCH /api/config/drive-pasta-raiz — body { drive_pasta_raiz_id }. Aceita id puro ou link completo da pasta. */
export function atualizarDrivePastaRaiz(valor) {
  return request("/api/config/drive-pasta-raiz", {
    method: "PATCH",
    body: { drive_pasta_raiz_id: valor },
  });
}

/**
 * GET /api/config/google-service-account — Multi-franquia, Passo 4.
 * Retorna { configurado, client_email, project_id } — nunca a credencial
 * completa (é um segredo, mesmo tratamento da chave do Asaas).
 */
export function getGoogleServiceAccount() {
  return request("/api/config/google-service-account");
}

/**
 * PATCH /api/config/google-service-account — body { credencial }. Aceita o
 * JSON cru (colado direto) ou em base64, mesmo formato aceito antes pela
 * variável de ambiente GOOGLE_SERVICE_ACCOUNT_JSON.
 */
export function atualizarGoogleServiceAccount(credencial) {
  return request("/api/config/google-service-account", {
    method: "PATCH",
    body: { credencial },
  });
}
