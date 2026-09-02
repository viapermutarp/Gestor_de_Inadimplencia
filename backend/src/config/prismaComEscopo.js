const prisma = require('./prisma');

/**
 * Multi-franquia — Fase 3 (ver docs/plano-multi-franquia.md, seção 4).
 *
 * Prisma Client Extension que aplica isolamento por franquia automaticamente
 * em toda operação nos 8 models tenant-scoped, sem exigir que cada
 * controller lembre de escrever "where: { franquiaId }" manualmente. Cada
 * requisição autenticada recebe um client escopado (`req.prisma`, montado
 * pelo middleware `escopoFranquia` logo depois de `auth` — ver
 * src/middleware/escopoFranquia.js) em vez de importar o client global
 * direto.
 *
 * Dois grupos de models, tratados de forma estruturalmente diferente:
 *   - ESCOPO_DIRETO: tem a coluna "franquiaId" na própria tabela.
 *   - ESCOPO_RELACAO: só tem "associadoId" — a franquia é sempre a do
 *     Associado relacionado (Cobranca, HistoricoStatusAssociado).
 *
 * Estratégia por tipo de operação (ver seção 4 do plano pra a justificativa
 * de cada uma):
 *   - findMany/count/aggregate/groupBy/updateMany/deleteMany: filtro
 *     injetado direto no "where" (merge, nunca sobrescreve o que o
 *     controller já passou), porque o Prisma aceita filtro de relação
 *     nativamente nesses.
 *   - findUnique/findFirst (singular): reescrito internamente como
 *     findFirst no client BASE (não-extendido, pra nunca recursar) com o
 *     filtro de franquia mesclado — nunca usa "query()" aqui, porque
 *     findUnique é tipado como WhereUniqueInput e nem sempre aceita
 *     combinar com um filtro extra de forma confiável.
 *   - update/delete (singular): "checa antes com findFirst (client base,
 *     filtro mesclado), depois executa a operação original" — se o check
 *     não achar nada, lança um erro com "code: 'P2025'" (mesmo formato que
 *     o Prisma usa pra "registro não encontrado", pra qualquer catch
 *     existente que já trate esse código continuar funcionando sem
 *     mudança). Só se o check achar, chama "query(args)" com o "where"
 *     ORIGINAL (só a chave única, sem o filtro extra) — já confirmado
 *     pertencer à franquia certa.
 *   - create: injeta "franquiaId" nos dados quando o controller não
 *     informou (isso é o que substitui a ponte temporária
 *     franquiaPadrao.service.js); se o controller informou um franquiaId
 *     que não bate com o da sessão, rejeita. Pros 2 models de relação,
 *     valida que o "associadoId" informado pertence à franquia certa antes
 *     de deixar criar.
 *   - createMany: mesma ideia do create, mas em lote — extrai os
 *     "associadoId" (relação) ou "franquiaId" (direto) distintos de todos
 *     os itens, valida numa query só, e rejeita o LOTE INTEIRO (não filtra
 *     item a item) se qualquer um não bater — ver seção 4 do plano pro
 *     porquê de ser tudo-ou-nada.
 *   - upsert: só usado hoje em Associado (sync.controller.js). Como a
 *     chave usada (cpf_cnpj) é única GLOBALMENTE, não por franquia, o
 *     tratamento é: busca se já existe em QUALQUER franquia; se não existe,
 *     segue o branch de "create" (validando/injetando franquiaId); se
 *     existe e é da MESMA franquia, executa só o "update"; se existe e é de
 *     OUTRA franquia, rejeita com um erro claro de conflito (nunca sobrescreve
 *     nem "rouba" o registro de outra franquia).
 */

const ESCOPO_DIRETO = [
  'associado',
  'cadastroEnviado',
  'modeloContrato',
  'cobrancaIgnorada',
  'syncLog',
  'apiKey',
  // Kanban "Jurídico" (aba nova) — ambos com franquiaId direto na própria
  // tabela (ver docblock dos models em schema.prisma). O vínculo opcional
  // de CardJuridico com Associado NÃO é tratado aqui como ESCOPO_RELACAO
  // (a franquia do card já vem do próprio card, não do associado) — é
  // validado manualmente no controller (juridico.controller.js), igual ao
  // resto dos campos "extra" que apontam pra outro tenant-model.
  'etapaJuridico',
  'cardJuridico',
  // Log de alterações dos cards do Jurídico (ver ajuste "Log de atualização
  // dos cards do Jurídico" e docblock do model em schema.prisma) — mesma
  // justificativa de EtapaJuridico/CardJuridico, franquiaId direto na
  // própria tabela.
  'historicoCardJuridico',
];
const ESCOPO_RELACAO = ['cobranca', 'historicoStatusAssociado'];
const MODELOS_TENANT = new Set([...ESCOPO_DIRETO, ...ESCOPO_RELACAO]);

function nomeAccessor(model) {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

function erroNaoEncontrado() {
  return Object.assign(
    new Error('An operation failed because it depends on one or more records that were required but not found.'),
    { code: 'P2025' }
  );
}

function erroConflitoFranquia(mensagem) {
  return Object.assign(new Error(mensagem), { status: 409 });
}

function erroSemPermissao(mensagem) {
  return Object.assign(new Error(mensagem), { status: 403 });
}

function erroNaoEncontradoHttp(mensagem) {
  return Object.assign(new Error(mensagem), { status: 404 });
}

/** Mescla um "where" com o filtro de franquia — via relação (Associado) ou direto. */
function mesclarFiltroFranquia(where, franquiaId, relacao) {
  const base = where || {};
  if (relacao) {
    return { ...base, associado: { ...(base.associado || {}), franquiaId } };
  }
  return { ...base, franquiaId };
}

/**
 * Confirma (via findFirst no client BASE) que o registro identificado por
 * "whereUnico" (a chave única original, sem alteração) pertence à franquia
 * "franquiaId". Lança erro "P2025" se não achar — usado por update/delete
 * singulares, antes de executar a operação de verdade.
 */
async function garantirRegistroDaFranquia(nomeModel, whereUnico, franquiaId, relacao) {
  const whereComFiltro = mesclarFiltroFranquia(whereUnico, franquiaId, relacao);
  const encontrado = await prisma[nomeModel].findFirst({ where: whereComFiltro });
  if (!encontrado) throw erroNaoEncontrado();
  return encontrado;
}

/** create singular: injeta/valida franquiaId (escopo direto) ou associadoId (escopo relação). */
async function prepararCreate(nomeModel, data, franquiaId, relacao) {
  if (!data) throw new Error(`create de "${nomeModel}" chamado sem "data".`);

  if (relacao) {
    const associadoId = data.associadoId;
    if (!associadoId) {
      throw new Error(`create de "${nomeModel}" precisa de "associadoId".`);
    }
    const associado = await prisma.associado.findFirst({ where: { id: associadoId, franquiaId } });
    if (!associado) {
      throw erroNaoEncontradoHttp('Associado não encontrado nesta franquia.');
    }
    return;
  }

  if (data.franquiaId !== undefined && data.franquiaId !== null) {
    if (data.franquiaId !== franquiaId) {
      throw erroSemPermissao('Não é permitido criar um registro em outra franquia.');
    }
  } else {
    data.franquiaId = franquiaId;
  }
}

/** createMany: valida o lote inteiro numa query só; rejeita tudo-ou-nada. */
async function prepararCreateMany(nomeModel, data, franquiaId, relacao) {
  if (!Array.isArray(data) || data.length === 0) return;

  if (relacao) {
    const idsDistintos = [...new Set(data.map((item) => item.associadoId).filter(Boolean))];
    if (idsDistintos.length !== data.length && data.some((item) => !item.associadoId)) {
      throw new Error(`createMany de "${nomeModel}": todo item precisa de "associadoId".`);
    }
    const encontrados = await prisma.associado.findMany({
      where: { id: { in: idsDistintos }, franquiaId },
      select: { id: true },
    });
    const encontradosSet = new Set(encontrados.map((a) => a.id));
    const faltando = idsDistintos.filter((id) => !encontradosSet.has(id));
    if (faltando.length > 0) {
      throw erroConflitoFranquia(
        `createMany de "${nomeModel}" rejeitado: associado(s) de outra franquia (ou inexistente) no lote — nenhum item foi inserido.`
      );
    }
    return;
  }

  for (const item of data) {
    if (item.franquiaId !== undefined && item.franquiaId !== null && item.franquiaId !== franquiaId) {
      throw erroConflitoFranquia(
        `createMany de "${nomeModel}" rejeitado: item com franquiaId de outra franquia no lote — nenhum item foi inserido.`
      );
    }
  }
  for (const item of data) {
    item.franquiaId = franquiaId;
  }
}

/**
 * upsert: hoje só usado em Associado (cpf_cnpj — único globalmente, não por
 * franquia). Busca se já existe em QUALQUER franquia antes de decidir entre
 * create/update/rejeitar.
 */
async function executarUpsertEscopado({ nomeModel, args, franquiaId, relacao, query }) {
  const existenteGlobal = await prisma[nomeModel].findFirst({ where: args.where });

  if (!existenteGlobal) {
    await prepararCreate(nomeModel, args.create, franquiaId, relacao);
    return query(args);
  }

  const franquiaDoExistente = relacao
    ? (await prisma.associado.findUnique({ where: { id: existenteGlobal.associadoId }, select: { franquiaId: true } }))
        ?.franquiaId
    : existenteGlobal.franquiaId;

  if (franquiaDoExistente !== franquiaId) {
    throw erroConflitoFranquia(
      `Já existe um registro com essa chave em outra franquia — não é possível criar nem atualizar por aqui.`
    );
  }

  return prisma[nomeModel].update({ where: args.where, data: args.update });
}

/**
 * Constrói um Prisma Client com isolamento por franquia aplicado. Se
 * "franquiaId" for null (só acontece pra SUPER_ADMIN sem seleção explícita
 * de franquia — ver escopoFranquia.js), retorna o client BASE sem nenhum
 * filtro (vê tudo), exatamente como documentado na seção 4 do plano.
 */
function criarPrismaEscopado(franquiaId) {
  if (!franquiaId) return prisma;

  return prisma.$extends({
    name: 'escopoFranquia',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const nomeModel = nomeAccessor(model);
          if (!MODELOS_TENANT.has(nomeModel)) {
            return query(args);
          }
          const relacao = ESCOPO_RELACAO.includes(nomeModel);

          switch (operation) {
            case 'findUnique':
            case 'findUniqueOrThrow':
            case 'findFirst':
            case 'findFirstOrThrow': {
              const whereComFiltro = mesclarFiltroFranquia(args.where, franquiaId, relacao);
              const encontrado = await prisma[nomeModel].findFirst({ ...args, where: whereComFiltro });
              if (!encontrado) {
                if (operation.endsWith('OrThrow')) throw erroNaoEncontrado();
                return null;
              }
              return encontrado;
            }

            case 'findMany':
            case 'count':
            case 'aggregate':
            case 'groupBy':
            case 'updateMany':
            case 'deleteMany': {
              const whereComFiltro = mesclarFiltroFranquia(args.where, franquiaId, relacao);
              return query({ ...args, where: whereComFiltro });
            }

            case 'update':
            case 'delete': {
              await garantirRegistroDaFranquia(nomeModel, args.where, franquiaId, relacao);
              return query(args);
            }

            case 'upsert':
              return executarUpsertEscopado({ nomeModel, args, franquiaId, relacao, query });

            case 'create':
              await prepararCreate(nomeModel, args.data, franquiaId, relacao);
              return query(args);

            case 'createMany':
              await prepararCreateMany(nomeModel, args.data, franquiaId, relacao);
              return query(args);

            default:
              // Qualquer operação não prevista explicitamente (ex.: futuras
              // adições do Prisma) — recusa por padrão, mais seguro que
              // deixar passar sem filtro de franquia.
              throw new Error(
                `Operação Prisma "${operation}" não tem tratamento de isolamento por franquia definido para o model "${model}".`
              );
          }
        },
      },
    },
  });
}

/**
 * Monta o client escopado pra uma requisição autenticada, a partir de
 * "req.auth" (ver middleware/auth.js) e, pro SUPER_ADMIN, de um
 * "?franquia_id=" explícito na query string (nunca automático/implícito).
 *
 * Regras (ver seção 4 do plano):
 *   - Autenticação por API key: sempre escopado pela franquiaId da própria
 *     ApiKey usada (nunca irrestrito — uma API key pertence a exatamente
 *     uma franquia).
 *   - JWT, papel SUPER_ADMIN: sem "?franquia_id=" na query, client BASE sem
 *     filtro (vê tudo); com "?franquia_id=", escopado por esse valor.
 *   - JWT, qualquer outro papel: sempre escopado pela franquiaId da própria
 *     sessão (req.auth.franquiaId) — nunca lê "?franquia_id=" da query
 *     (só o SUPER_ADMIN pode "escolher" franquia).
 *
 * Lança erro (403) se uma sessão não-SUPER_ADMIN não tiver franquiaId —
 * estado que não deveria acontecer nunca (todo Usuario não-SUPER_ADMIN tem
 * franquiaId obrigatório), mas falha travado (nunca abre acesso irrestrito
 * por engano) em vez de silenciosamente deixar passar sem filtro.
 */
/**
 * Resolve o "franquiaId" efetivo de uma requisição autenticada (mesma regra
 * usada por "prismaParaRequisicao" — ver docblock dela) — extraído à parte
 * porque também é usado por trechos que rodam SQL cru via "$queryRaw"
 * (ver associados.controller.js: "listar"/"resumo"), que a extension NÃO
 * intercepta (Prisma Client Extensions só interceptam chamadas via ORM —
 * findMany/create/etc. —, nunca $queryRaw/$queryRawUnsafe). Retorna `null`
 * pro caso "irrestrito" (SUPER_ADMIN sem "?franquia_id=" explícito).
 */
function resolverFranquiaIdDaRequisicao(req) {
  const auth = req.auth || {};

  if (auth.type === 'api_key') {
    if (!auth.franquiaId) {
      throw erroSemPermissao('Chave de API sem franquia associada.');
    }
    return auth.franquiaId;
  }

  if (auth.papel === 'SUPER_ADMIN') {
    const explicita = req.query?.franquia_id;
    if (typeof explicita === 'string' && explicita.trim() !== '') {
      return explicita.trim();
    }
    return null; // irrestrito
  }

  if (!auth.franquiaId) {
    throw erroSemPermissao('Sessão sem franquia associada.');
  }
  return auth.franquiaId;
}

function prismaParaRequisicao(req) {
  return criarPrismaEscopado(resolverFranquiaIdDaRequisicao(req));
}

module.exports = { prismaParaRequisicao, criarPrismaEscopado, resolverFranquiaIdDaRequisicao };
