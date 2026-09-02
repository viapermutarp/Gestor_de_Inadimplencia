const prisma = require('../config/prisma');

/**
 * PONTE TEMPORÁRIA — Fase 1 do multi-franquia (ver docs/plano-multi-franquia.md).
 *
 * A Fase 1 tornou `franquia_id` obrigatório (`NOT NULL`) em associados,
 * cadastros_enviados, modelos_contrato, cobrancas_ignoradas, sync_log,
 * api_keys e configuracoes — mas o isolamento de verdade (cada requisição
 * autenticada sabendo sua própria franquia via `req.auth`/`req.prisma`) só
 * chega na Fase 3 (Prisma Client Extension + wiring dos controllers).
 * Até lá, e enquanto só existir 1 franquia em produção, todo `create`/
 * `upsert`/leitura que precisa de um `franquia_id` usa este helper, que
 * resolve a ÚNICA franquia existente e guarda em cache (processo, em
 * memória — não muda em runtime hoje, então recalcular a cada chamada só
 * custaria uma query à toa).
 *
 * ISSO PRECISA SER REMOVIDO/SUBSTITUÍDO na Fase 3: nesse ponto, cada
 * controller passa a resolver a franquia a partir da sessão autenticada
 * (`req.auth.franquiaId`), não mais "a única que existe" — múltiplas
 * franquias deixam de ser um caso hipotético.
 *
 * Lança um erro claro (em vez de continuar silenciosamente) se não houver
 * NENHUMA franquia — não deveria acontecer nunca em produção, já que a
 * migração da Fase 1 sempre semeia uma, mas é melhor um 500 explícito do
 * que gravar um registro com franquia_id indefinido.
 */

let franquiaIdCache = null;

async function obterFranquiaIdPadrao() {
  if (franquiaIdCache) return franquiaIdCache;

  const franquia = await prisma.franquia.findFirst({ orderBy: { criadoEm: 'asc' } });
  if (!franquia) {
    throw new Error(
      'Nenhuma franquia encontrada na tabela "franquias" — não é possível gravar/ler registros ' +
        'que dependem de franquia_id. Isso não deveria acontecer: a migração da Fase 1 do ' +
        'multi-franquia sempre semeia uma franquia. Verifique se as migrações foram aplicadas.'
    );
  }

  franquiaIdCache = franquia.id;
  return franquiaIdCache;
}

/** Só para uso em testes — limpa o cache entre cenários que recriam o banco. */
function _resetCacheParaTeste() {
  franquiaIdCache = null;
}

/**
 * Multi-franquia — Passo 4: resolve a franquia a usar numa leitura/escrita
 * de configuração (config.service.js) a partir da requisição. Pra qualquer
 * usuário normal, "req.franquiaId" já vem certo (a própria franquia da
 * sessão). Só fica `null` no caso irrestrito do SUPER_ADMIN sem
 * "?franquia_id=" explícito (ver escopoFranquia.js) — cenário de hoje
 * (único usuário, única franquia, sem seletor de franquia na tela ainda —
 * ver seção 6 do plano, "Controle Geral", ainda não implementada) — cai
 * neste mesmo fallback pragmático que já existia antes da Fase 3
 * (`obterFranquiaIdPadrao`, acima): a única franquia existente. Evita
 * quebrar a tela de Configurações pro SUPER_ADMIN de hoje enquanto o
 * seletor de franquia não existe. Usado por config.controller.js,
 * inadimplencia.controller.js e cadastros.controller.js — um único lugar
 * pra essa exceção documentada, em vez de duplicá-la em cada controller.
 */
async function resolverFranquiaIdOuPadrao(req) {
  return req.franquiaId ?? (await obterFranquiaIdPadrao());
}

module.exports = { obterFranquiaIdPadrao, resolverFranquiaIdOuPadrao, _resetCacheParaTeste };
