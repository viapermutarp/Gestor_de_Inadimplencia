import { getToken, getRefreshToken, setSession, clearToken, getFranquiaSelecionada } from "./auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Multi-franquia — Etapa 5 ("Controle Geral", item 4 do escopo). Quando o
 * SUPER_ADMIN tem uma franquia "selecionada" (seletor no topo, ver
 * components/FranquiaSelector.js), toda chamada autenticada passa a
 * carregar "?franquia_id=..." — é o parâmetro que o backend já aceita
 * desde a Fase 3 (ver prismaComEscopo.js:resolverFranquiaIdDaRequisicao)
 * pra escopar o client Prisma da requisição por essa franquia, em vez do
 * modo "irrestrito" (sem seleção = vê tudo, usado só nas próprias rotas de
 * Controle Geral). Pra um usuário de franquia comum (não SUPER_ADMIN),
 * nunca existe seleção (ver isSuperAdmin()/FranquiaSelector), então isso
 * nunca entra em jogo — o backend também ignora esse parâmetro pra
 * qualquer sessão que não seja SUPER_ADMIN.
 */
function comFranquiaSelecionada(path) {
  const franquiaId = getFranquiaSelecionada();
  if (!franquiaId) return path;

  const [base, query] = path.split("?");
  const params = new URLSearchParams(query || "");
  params.set("franquia_id", franquiaId);
  return `${base}?${params.toString()}`;
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
  let caminhoFinal = path;

  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    caminhoFinal = comFranquiaSelecionada(path);
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
    ({ res, data } = await fetchJson(caminhoFinal, { method, headers, body, signal: controller?.signal }));
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
 *
 * `visao` (renomeado de `visaoFaixas`/"visao_faixas" — AJUSTE 6) aceita
 * "aberto" (padrão, sem regressão) | "historico", e agora controla AO MESMO
 * TEMPO `faixas`/`criticos_90_dias` E `valor_inadimplente`/
 * `valor_adimplente`/as duas taxas (antes, só as faixas):
 *   - "aberto": os 3 cards por STATUS ATUAL de cada cobrança no Asaas
 *     (snapshot de hoje).
 *   - "historico": os 3 cards pela mesma classificação por data de
 *     pagamento vs. vencimento que já alimentava só as faixas — reflete o
 *     comportamento do associado no período (pagou em dia ou não),
 *     independente do status atual.
 * `tipoPendencia` só tem efeito quando `visao: "aberto"` — ver docblock
 * abaixo.
 *
 * `forcar: true` ignora o cache do backend para ESTA chamada (sempre busca
 * dados frescos do Asaas), mas o resultado novo ainda fica cacheado lá para
 * as chamadas seguintes — usado pelo botão "Atualizar" da tela.
 *
 * Se a chave de API do Asaas não estiver configurada, o backend responde
 * 400 com uma mensagem citando "asaas-key" — ver tratamento em
 * app/inadimplencia/page.js.
 */
/**
 * `tipoPendencia` ("todos"|"vencidas"|"confirmadas", padrão "todos" no
 * backend) — filtra quais status entram em "valor_inadimplente"/
 * "taxa_inadimplencia_percentual": "vencidas" = só status OVERDUE,
 * "confirmadas" = só status CONFIRMED (crédito futuro, ainda não caiu na
 * conta). Nunca afeta "valor_adimplente" nem "valor_total_faturado". SÓ TEM
 * EFEITO quando `visao: "aberto"` (padrão) — em `visao: "historico"` é
 * ignorado pelo backend (não há um equivalente de "vencidas"/"confirmadas"
 * numa classificação por data); o frontend desabilita visualmente o campo
 * nesse caso (ver app/inadimplencia/page.js) — ver README, seção "Taxa de
 * Inadimplência".
 */
export function getResumoInadimplencia({
  vencDe,
  vencAte,
  renegociacao,
  emJuridico,
  bloqueado,
  tipoPendencia,
  visao,
  forcar,
} = {}) {
  const params = new URLSearchParams();
  if (vencDe) params.set("venc_de", vencDe);
  if (vencAte) params.set("venc_ate", vencAte);
  if (renegociacao) params.set("renegociacao", renegociacao);
  if (emJuridico) params.set("em_juridico", emJuridico);
  if (bloqueado) params.set("bloqueado", bloqueado);
  if (tipoPendencia) params.set("tipo_pendencia", tipoPendencia);
  if (visao) params.set("visao", visao);
  if (forcar) params.set("forcar", "true");

  const query = params.toString();
  return request(`/api/inadimplencia/resumo${query ? `?${query}` : ""}`);
}

/**
 * GET /api/inadimplencia/evolucao-mensal — mesmos números do /resumo
 * (valor_total_faturado, valor_inadimplente, taxa_inadimplencia_percentual),
 * mais taxa_adimplencia_percentual, agrupados por mês ("YYYY-MM"). Mesmos
 * parâmetros de filtro do /resumo (`renegociacao`/`emJuridico`/`bloqueado`/
 * `tipoPendencia`, `forcar`), mas NÃO aceita `visao` (AJUSTE 6 — a
 * unificação com o toggle "aberto"/"historico" foi só para os 3 cards do
 * /resumo; este endpoint continua exclusivamente por status atual, sempre,
 * e também não devolve faixas).
 */
export function getEvolucaoMensal({ vencDe, vencAte, renegociacao, emJuridico, bloqueado, tipoPendencia, forcar } = {}) {
  const params = new URLSearchParams();
  if (vencDe) params.set("venc_de", vencDe);
  if (vencAte) params.set("venc_ate", vencAte);
  if (renegociacao) params.set("renegociacao", renegociacao);
  if (emJuridico) params.set("em_juridico", emJuridico);
  if (bloqueado) params.set("bloqueado", bloqueado);
  if (tipoPendencia) params.set("tipo_pendencia", tipoPendencia);
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
 * excluir automaticamente cobranças do cálculo de Taxa de Inadimplência.
 * Cada palavra casa (contains, case-insensitive) contra a descrição da
 * cobrança, o CPF/CNPJ do associado (com ou sem formatação) ou o nome/razão
 * social do associado — ver ExclusoesPanel.js.
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

/**
 * Multi-franquia — Etapa 5 ("Controle Geral"). Todas as funções abaixo só
 * funcionam para uma sessão SUPER_ADMIN (403 do backend caso contrário —
 * ver middleware/exigirSuperAdmin.js); o frontend só as chama a partir da
 * tela /controle-geral, que por sua vez só é exibida/roteável pra
 * SUPER_ADMIN (ver isSuperAdmin() em lib/auth.js).
 */

/**
 * GET /api/franquias — todas as franquias, cada uma já com TODOS os
 * usuários dela embutidos (mais antigo primeiro):
 * [{ id, nome, ativo, criado_em, usuarios: [{ id, nome, email, ativo,
 * ultimo_login_em, recursos_permitidos }, ...] }]. "usuarios: []" acontece
 * só pra franquias que nunca passaram por `criarFranquia` nem por
 * `criarUsuarioExtra` (hoje, na prática, só a franquia semeada pela
 * migração da Fase 1). Desde o ajuste "Super Admin pode adicionar mais de
 * 1 usuário numa franquia" (ver docs/plano-multi-franquia.md, seção 8,
 * item 8), cada usuário tem "recursos_permitidos" PRÓPRIO — a franquia em
 * si não tem mais um "recursos_permitidos" no nível dela.
 */
export function listarFranquias() {
  return request("/api/franquias");
}

/**
 * POST /api/franquias — body { nome, usuario: { nome, email, senha },
 * recursos_permitidos? }. Cria a franquia e o usuário TITULAR dela juntos
 * (não existe franquia "vazia" neste desenho). "recursosPermitidos" é
 * opcional: sem ele, o titular nasce com todos os recursos liberados por
 * padrão. Pra adicionar mais usuários a uma franquia já existente, ver
 * `criarUsuarioExtra` abaixo.
 */
export function criarFranquia({ nome, usuario, recursosPermitidos }) {
  return request("/api/franquias", {
    method: "POST",
    body: { nome, usuario, recursos_permitidos: recursosPermitidos },
  });
}

/** PATCH /api/franquias/:id — body: qualquer subconjunto de { nome, ativo }. */
export function atualizarFranquia(id, dados) {
  return request(`/api/franquias/${encodeURIComponent(id)}`, { method: "PATCH", body: dados });
}

/**
 * DELETE /api/franquias/:id/excluir-permanente — ALTO RISCO: apaga a
 * franquia e TODO dado vinculado a ela dentro do Gestor, de forma
 * definitiva e irreversível (ver docblock de
 * excluirPermanentemente em franquias.controller.js pra lista completa
 * do que é apagado). Diferente de `atualizarFranquia(id, { ativo: false })`
 * (reversível). "confirmarNome" precisa bater EXATAMENTE com o nome atual
 * da franquia — mesma checagem que o backend faz de novo do lado dele
 * (nunca confie só na validação do frontend pra uma operação destrutiva
 * como essa). Não apaga nada em serviços externos (Asaas, Bling, Google
 * Drive) — ver "aviso" na resposta, exibido pelo ModalExcluirFranquia em
 * app/controle-geral/page.js.
 */
export function excluirFranquiaPermanentemente(id, confirmarNome) {
  return request(`/api/franquias/${encodeURIComponent(id)}/excluir-permanente`, {
    method: "DELETE",
    body: { confirmar_nome: confirmarNome },
  });
}

/**
 * POST /api/franquias/:id/usuarios — body { nome, email, senha,
 * recursos_permitidos? }. Ajuste "Super Admin pode adicionar mais de 1
 * usuário numa franquia" — adiciona um login EXTRA a uma franquia já
 * existente, com telas liberadas próprias (independentes dos outros
 * usuários dela). "recursosPermitidos" opcional: sem ele, nasce com todos
 * os recursos liberados por padrão.
 */
export function criarUsuarioExtra(franquiaId, { nome, email, senha, recursosPermitidos }) {
  return request(`/api/franquias/${encodeURIComponent(franquiaId)}/usuarios`, {
    method: "POST",
    body: { nome, email, senha, recursos_permitidos: recursosPermitidos },
  });
}

/** PATCH /api/usuarios/:id — body { ativo }. Bloqueia/desbloqueia o acesso de um usuário. */
export function atualizarStatusUsuario(id, ativo) {
  return request(`/api/usuarios/${encodeURIComponent(id)}`, { method: "PATCH", body: { ativo } });
}

/**
 * PATCH /api/usuarios/:id — body { recursos_permitidos }. Troca as telas
 * liberadas de um usuário específico (ver escopo do ajuste "Super Admin
 * pode adicionar mais de 1 usuário numa franquia" — movido de
 * `atualizarFranquia`, que não aceita mais esse campo).
 */
export function atualizarRecursosUsuario(id, recursosPermitidos) {
  return request(`/api/usuarios/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { recursos_permitidos: recursosPermitidos },
  });
}

/** POST /api/usuarios/:id/resetar-senha — body { senha }. O SUPER_ADMIN define uma senha nova para o usuário. */
export function resetarSenhaUsuario(id, senha) {
  return request(`/api/usuarios/${encodeURIComponent(id)}/resetar-senha`, {
    method: "POST",
    body: { senha },
  });
}

/** GET /api/perfil — dados do próprio usuário autenticado (id, nome, email, papel). */
export function getPerfil() {
  return request("/api/perfil");
}

/**
 * PATCH /api/perfil — body { nome?, email?, senha_atual, senha_nova? }.
 * Troca as próprias credenciais — sempre exige "senha_atual" correta,
 * mesmo pra trocar só o nome.
 */
export function atualizarPerfil({ nome, email, senhaAtual, senhaNova }) {
  return request("/api/perfil", {
    method: "PATCH",
    body: {
      nome,
      email,
      senha_atual: senhaAtual,
      senha_nova: senhaNova || undefined,
    },
  });
}

/**
 * Kanban "Jurídico" (aba nova — ver escopo do pedido, item 1). Todas as
 * funções abaixo exigem o recurso "juridico" liberado pra franquia da
 * sessão (403 do backend caso contrário — ver middleware/exigirRecurso.js).
 */

/** GET /api/juridico/etapas — o board inteiro: etapas ordenadas, cada uma já com seus cards (ordenados). */
export function listarEtapasJuridico() {
  return request("/api/juridico/etapas");
}

/** POST /api/juridico/etapas — body { nome }. Nasce como última coluna. */
export function criarEtapaJuridico(nome) {
  return request("/api/juridico/etapas", { method: "POST", body: { nome } });
}

/** PATCH /api/juridico/etapas/:id — body { nome }. Renomear (não mexe na ordem). */
export function renomearEtapaJuridico(id, nome) {
  return request(`/api/juridico/etapas/${encodeURIComponent(id)}`, { method: "PATCH", body: { nome } });
}

/** POST /api/juridico/etapas/reordenar — body { ids }, a nova ordem completa das colunas (drag and drop). */
export function reordenarEtapasJuridico(ids) {
  return request("/api/juridico/etapas/reordenar", { method: "POST", body: { ids } });
}

/**
 * DELETE /api/juridico/etapas/:id — sem "confirmar", uma etapa com cards
 * responde 409 { total_cards }; chame de novo com `confirmar: true` pra
 * remover a etapa e os cards dela junto.
 */
export function removerEtapaJuridico(id, { confirmar } = {}) {
  const query = confirmar ? "?confirmar=true" : "";
  return request(`/api/juridico/etapas/${encodeURIComponent(id)}${query}`, { method: "DELETE" });
}

/**
 * GET /api/juridico/associados-busca?busca=termo — busca por nome/CPF/CNPJ/
 * telefone (mesmo padrão do Dashboard), usada só pra vincular um card a um
 * associado existente. Resposta enxuta (top 20), já com "valor_em_aberto".
 */
export function buscarAssociadosJuridico(busca) {
  const params = new URLSearchParams();
  if (busca) params.set("busca", busca);
  return request(`/api/juridico/associados-busca?${params.toString()}`);
}

/**
 * POST /api/juridico/cards — body { etapa_id, associado_id?, titulo?,
 * descricao?, observacoes?, responsavel?, prazo? }. Exatamente uma origem:
 * "associadoId" (vinculado) OU "titulo" (livre) — nunca os dois, nunca
 * nenhum. "titulo" só existe pra card livre (vinculado usa o nome do
 * associado). "descricao" e "observacoes" valem nos dois modos.
 */
export function criarCardJuridico({ etapaId, associadoId, titulo, descricao, observacoes, responsavel, prazo }) {
  return request("/api/juridico/cards", {
    method: "POST",
    body: {
      etapa_id: etapaId,
      associado_id: associadoId || undefined,
      titulo: titulo || undefined,
      descricao: descricao || undefined,
      observacoes: observacoes || undefined,
      responsavel: responsavel || undefined,
      prazo: prazo || undefined,
    },
  });
}

/**
 * PATCH /api/juridico/cards/:id — qualquer subconjunto de { titulo,
 * descricao, observacoes, responsavel, prazo }. Nunca muda associado/etapa
 * (pra mover entre colunas, ver `moverCardJuridico`). "titulo" só é aceito
 * pra card livre; "descricao" e "observacoes" valem nos dois modos.
 */
export function atualizarCardJuridico(id, dados) {
  return request(`/api/juridico/cards/${encodeURIComponent(id)}`, { method: "PATCH", body: dados });
}

/**
 * GET /api/juridico/cards/:id/historico — histórico de alterações do card
 * (mudança de etapa, edição de campo, criação, exclusão), mais recente
 * primeiro. Cada item: { id, campo_alterado, valor_anterior, valor_novo,
 * usuario_id, usuario_nome, criado_em }. Isolado por franquia (mesma
 * extensão do Prisma usada em todo o resto do Jurídico).
 */
export function historicoCardJuridico(id) {
  return request(`/api/juridico/cards/${encodeURIComponent(id)}/historico`);
}

/**
 * PATCH /api/juridico/cards/:id/mover — body { etapa_id, indice }. Move o
 * card (drag and drop) pra "etapaId" na posição "indice" (0-based) da
 * lista de destino — pode ser a mesma etapa, só reordenando.
 */
export function moverCardJuridico(id, { etapaId, indice }) {
  return request(`/api/juridico/cards/${encodeURIComponent(id)}/mover`, {
    method: "PATCH",
    body: { etapa_id: etapaId, indice },
  });
}

/** DELETE /api/juridico/cards/:id */
export function removerCardJuridico(id) {
  return request(`/api/juridico/cards/${encodeURIComponent(id)}`, { method: "DELETE" });
}
