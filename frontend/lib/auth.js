// Sessão do painel = access token curto (JWT) + refresh token de vida
// longa, revogável no servidor (ver "Autenticação: access token curto +
// refresh token" no README do backend). O refresh token é o sinal real de
// "existe uma sessão" — o access token expira sozinho a cada poucos
// minutos por design (ver lib/api.js, que renova em segundo plano sempre
// que uma chamada autenticada leva 401 por access token vencido).
const TOKEN_KEY = "gdi_token";
const REFRESH_TOKEN_KEY = "gdi_refresh_token";
const FRANQUIA_SELECIONADA_KEY = "gdi_franquia_selecionada";

export function getToken() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getRefreshToken() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Guarda os dois tokens de uma sessão nova (login ou refresh bem-sucedido). */
export function setSession({ token, refreshToken }) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TOKEN_KEY, token);
  if (refreshToken) window.localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
}

// Mantido por compatibilidade — prefira `setSession`, que também guarda o
// refresh token. Só o access token sozinho não sustenta a sessão.
export function setToken(token) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(REFRESH_TOKEN_KEY);
  clearFranquiaSelecionada();
}

/**
 * Multi-franquia — Etapa 5 ("Controle Geral"). Claims do access token
 * (payload do JWT, ver refreshTokens.service.js:gerarAccessToken), lidos
 * direto no navegador SEM verificar assinatura — só pra decidir o que
 * mostrar na tela (ex.: esconder o link "Controle Geral" de quem não é
 * SUPER_ADMIN). A proteção de verdade é sempre no backend
 * (middleware/exigirSuperAdmin.js) — decodificar aqui é só UX, nunca
 * segurança. Retorna null se não houver token ou ele não for um JWT válido
 * (ex.: sessão autenticada só por API key, que não existe no navegador na
 * prática, mas o parse não deveria explodir mesmo assim).
 */
export function getClaims() {
  const token = getToken();
  if (!token) return null;
  try {
    const payloadBase64 = token.split(".")[1];
    const normalizado = payloadBase64.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(normalizado));
  } catch {
    return null;
  }
}

/** Papel "SUPER_ADMIN" enxerga todas as franquias e precisa escolher uma pra operar (ver getFranquiaSelecionada). */
export function isSuperAdmin() {
  return getClaims()?.papel === "SUPER_ADMIN";
}

/**
 * Restrição de telas por franquia (ver escopo do pedido, item 2). Chaves
 * válidas: "dashboard" | "inadimplencia" | "cadastro" | "contratos" |
 * "juridico" | "configuracoes" (mesmas de RECURSOS no backend, ver
 * src/config/recursos.js). `temRecurso` é usado tanto pelo AppHeader (só
 * mostra o link de tela liberada) quanto por RequireRecurso.js (bloqueia
 * acesso direto pela URL) — SUPER_ADMIN sempre "tem" qualquer recurso,
 * nunca lê o claim "recursosPermitidos" (que nem existe no token dele, ver
 * refreshTokens.service.js:gerarAccessToken).
 *
 * Só UX: o claim vem do access token (até 15min desatualizado se o
 * SUPER_ADMIN mudar os recursos da franquia no meio da sessão) — a
 * proteção de verdade é sempre o backend (middleware/exigirRecurso.js, que
 * consulta o banco a cada requisição). Se o claim ficar stale e permitir
 * renderizar uma tela que acabou de perder acesso, as chamadas de API
 * daquela tela tomam 403 normalmente e mostram o erro de sempre — não
 * quebra a aplicação, só não antecipa o bloqueio no clique do menu.
 */
export function temRecurso(chave) {
  const claims = getClaims();
  if (!claims) return false;
  if (claims.papel === "SUPER_ADMIN") return true;
  return Array.isArray(claims.recursosPermitidos) && claims.recursosPermitidos.includes(chave);
}

/** A franquia que o SUPER_ADMIN escolheu "entrar" (seletor no topo) — irrelevante para usuário de franquia comum (sempre a própria). */
export function getFranquiaSelecionada() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(FRANQUIA_SELECIONADA_KEY);
  } catch {
    return null;
  }
}

export function setFranquiaSelecionada(franquiaId) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(FRANQUIA_SELECIONADA_KEY, franquiaId);
}

export function clearFranquiaSelecionada() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(FRANQUIA_SELECIONADA_KEY);
}

/**
 * Existe uma sessão que vale a pena tentar usar/renovar? Checa o REFRESH
 * token, não o access token — o access token vence sozinho o tempo todo
 * por design (ver JWT_EXPIRES_IN no backend, hoje 15min) e isso é
 * esperado, não significa "sessão encerrada". `request()` (lib/api.js)
 * renova o access token em segundo plano usando o refresh token sempre
 * que precisar; só quando o PRÓPRIO refresh token está ausente, expirado
 * ou revogado é que a sessão de fato acabou.
 */
export function isAuthenticated() {
  return Boolean(getRefreshToken());
}
