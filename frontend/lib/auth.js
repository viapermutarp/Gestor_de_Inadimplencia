// Sessão do painel = access token curto (JWT) + refresh token de vida
// longa, revogável no servidor (ver "Autenticação: access token curto +
// refresh token" no README do backend). O refresh token é o sinal real de
// "existe uma sessão" — o access token expira sozinho a cada poucos
// minutos por design (ver lib/api.js, que renova em segundo plano sempre
// que uma chamada autenticada leva 401 por access token vencido).
const TOKEN_KEY = "gdi_token";
const REFRESH_TOKEN_KEY = "gdi_refresh_token";

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
