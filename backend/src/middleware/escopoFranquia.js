const { criarPrismaEscopado, resolverFranquiaIdDaRequisicao } = require('../config/prismaComEscopo');

/**
 * Multi-franquia — Fase 3. Monta "req.prisma" logo depois de "auth" (ver
 * routes/*.js — sempre "auth, escopoFranquia, ctrl.fn") — todo controller
 * passa a usar "req.prisma" em vez de importar o client global direto, pra
 * ter isolamento automático por franquia (ver src/config/prismaComEscopo.js
 * e docs/plano-multi-franquia.md, seção 4).
 *
 * Também expõe "req.franquiaId" (a mesma franquia usada pra montar
 * "req.prisma", ou `null` no caso irrestrito do SUPER_ADMIN sem
 * "?franquia_id=") — usado por trechos que rodam SQL cru via "$queryRaw"
 * (ver associados.controller.js), que a extension não intercepta.
 */
module.exports = function escopoFranquia(req, res, next) {
  try {
    req.franquiaId = resolverFranquiaIdDaRequisicao(req);
    req.prisma = criarPrismaEscopado(req.franquiaId);
    next();
  } catch (err) {
    next(err);
  }
};
