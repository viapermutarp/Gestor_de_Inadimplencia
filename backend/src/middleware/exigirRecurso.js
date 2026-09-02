const prisma = require('../config/prisma');
const { RECURSOS } = require('../config/recursos');

/**
 * Restrição de telas por USUÁRIO (ver docs/plano-multi-franquia.md, seção
 * 8, item 8, e src/config/recursos.js). Fábrica de middleware — uso:
 * `exigirRecurso('dashboard')`, sempre logo depois de "auth" (mesma posição
 * de exigirSuperAdmin.js), ANTES de "escopoFranquia" (não depende dele —
 * lê "req.auth" direto).
 *
 * Movido de Franquia.recursosPermitidos pra Usuario.recursosPermitidos no
 * ajuste "Super Admin pode adicionar mais de 1 usuário numa franquia" —
 * antes disso, todo usuário de uma franquia enxergava as mesmas telas
 * (recurso era da franquia); agora cada usuário tem sua própria lista,
 * mesmo dividindo os mesmos dados/integrações da franquia com outros
 * usuários dela.
 *
 * Duas isenções totais, nunca bloqueadas por "recursosPermitidos":
 *   - Autenticação por API key (integrações externas, ex.: n8n em
 *     POST /api/sync) — não é uma "tela", não faz sentido restringir.
 *   - Papel SUPER_ADMIN — sempre tem acesso a tudo, em qualquer franquia que
 *     tiver selecionada (ver escopo do pedido, item 2.2); nunca lê
 *     "recursosPermitidos" pra essa sessão.
 *
 * Pra qualquer outra sessão (usuário de franquia comum), busca
 * "recursosPermitidos" do PRÓPRIO USUÁRIO direto no banco a cada
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

      if (!req.auth.user) {
        return res.status(403).json({ error: 'Sessão sem usuário associado.' });
      }

      const usuario = await prisma.usuario.findUnique({
        where: { id: req.auth.user },
        select: { recursosPermitidos: true },
      });

      if (!usuario || !usuario.recursosPermitidos.includes(chave)) {
        return res.status(403).json({ error: 'Seu usuário não tem acesso a esta tela.' });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
};
