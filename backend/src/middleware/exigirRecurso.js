const prisma = require('../config/prisma');
const { RECURSOS } = require('../config/recursos');

/**
 * Restrição de telas por franquia (ver docs/plano-multi-franquia.md e
 * src/config/recursos.js). Fábrica de middleware — uso: `exigirRecurso('dashboard')`,
 * sempre logo depois de "auth" (mesma posição de exigirSuperAdmin.js), ANTES de
 * "escopoFranquia" (não depende dele — lê "req.auth" direto).
 *
 * Duas isenções totais, nunca bloqueadas por "recursosPermitidos":
 *   - Autenticação por API key (integrações externas, ex.: n8n em
 *     POST /api/sync) — não é uma "tela", não faz sentido restringir.
 *   - Papel SUPER_ADMIN — sempre tem acesso a tudo, em qualquer franquia que
 *     tiver selecionada (ver escopo do pedido, item 2.2); nunca lê
 *     "recursosPermitidos" pra essa sessão.
 *
 * Pra qualquer outra sessão (usuário de franquia comum), busca
 * "recursosPermitidos" da FRANQUIA DA SESSÃO direto no banco a cada
 * requisição (nunca confia num claim do JWT, que ficaria desatualizado até
 * o token expirar) — se a chave não estiver na lista, 403. Mesmo padrão de
 * erro que exigirSuperAdmin.js: 403 (não 401) — a autenticação em si já foi
 * validada por "auth"; isso aqui é só autorização.
 */
module.exports = function exigirRecurso(chave) {
  if (!RECURSOS.includes(chave)) {
    throw new Error(`exigirRecurso: recurso desconhecido "${chave}" (válidos: ${RECURSOS.join(', ')}).`);
  }

  return async function (req, res, next) {
    try {
      if (!req.auth) {
        return res.status(401).json({ error: 'Token de autenticação ausente ou inválido.' });
      }

      if (req.auth.type === 'api_key' || req.auth.papel === 'SUPER_ADMIN') {
        return next();
      }

      if (!req.auth.franquiaId) {
        return res.status(403).json({ error: 'Sessão sem franquia associada.' });
      }

      const franquia = await prisma.franquia.findUnique({
        where: { id: req.auth.franquiaId },
        select: { recursosPermitidos: true },
      });

      if (!franquia || !franquia.recursosPermitidos.includes(chave)) {
        return res.status(403).json({ error: 'Sua franquia não tem acesso a esta tela.' });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
};
