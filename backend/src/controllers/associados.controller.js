const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');

const COBRANCAS_ABERTAS = ['pending', 'overdue'];
const LIMITE_PADRAO = 100;
const LIMITE_MAXIMO = 100;

function serializeCobranca(cobranca) {
  return {
    id: cobranca.id,
    associado_id: cobranca.associadoId,
    valor: cobranca.valor,
    vencimento: cobranca.vencimento,
    dias_diferenca: cobranca.diasDiferenca,
    link_pagamento: cobranca.linkPagamento,
    descricao: cobranca.descricao,
    status: cobranca.status,
    sincronizado_em: cobranca.sincronizadoEm,
  };
}

// Valores possíveis de "campo" em historico_status_associado — os três
// status booleanos do associado que podem gerar uma linha de histórico.
// Usado só como documentação/referência (não há validação de entrada aqui:
// quem grava é sempre o próprio backend, nunca vem de payload externo).
const CAMPOS_HISTORICO_STATUS = ['em_negociacao', 'bloqueado', 'em_juridico'];

function serializeHistorico(historico) {
  return {
    id: historico.id,
    associado_id: historico.associadoId,
    campo: historico.campo,
    status_anterior: historico.statusAnterior,
    status_novo: historico.statusNovo,
    alterado_em: historico.alteradoEm,
  };
}

function serializeAssociado(associado) {
  const serialized = {
    id: associado.id,
    cpf_cnpj: associado.cpfCnpj,
    nome: associado.nome,
    telefone: associado.telefone,
    email: associado.email,
    em_negociacao: associado.emNegociacao,
    observacao: associado.observacao,
    observacao_atualizada_em: associado.observacaoAtualizadaEm,
    bloqueado: associado.bloqueado,
    em_juridico: associado.emJuridico,
    ciclo_resetado_em: associado.cicloResetadoEm,
    criado_em: associado.criadoEm,
    atualizado_em: associado.atualizadoEm,
  };

  if (associado.cobrancas) {
    serialized.cobrancas = associado.cobrancas.map(serializeCobranca);
  }

  if (associado.historicoStatus) {
    serialized.historico = associado.historicoStatus.map(serializeHistorico);
  }

  return serialized;
}

/**
 * Monta, a partir dos mesmos parâmetros de query aceitos por
 * GET /api/associados, um array de condições SQL (Prisma.sql) prontas para
 * serem combinadas com AND numa cláusula WHERE. Reaproveitado por
 * `listar` (todos os filtros) e por `resumo` (só "busca").
 */
function construirCondicoesFiltro({
  emNegociacaoParam,
  emJuridicoParam,
  bloqueadoParam,
  termoBusca,
  exigirCobrancaAberta,
} = {}) {
  const condicoes = [];

  if (emNegociacaoParam === 'true') condicoes.push(Prisma.sql`a.em_negociacao = true`);
  else if (emNegociacaoParam === 'false') condicoes.push(Prisma.sql`a.em_negociacao = false`);

  if (emJuridicoParam === 'true') condicoes.push(Prisma.sql`a.em_juridico = true`);
  else if (emJuridicoParam === 'false') condicoes.push(Prisma.sql`a.em_juridico = false`);

  if (bloqueadoParam === 'true') condicoes.push(Prisma.sql`a.bloqueado = true`);
  else if (bloqueadoParam === 'false') condicoes.push(Prisma.sql`a.bloqueado = false`);

  if (termoBusca) {
    const termo = `%${termoBusca}%`;
    condicoes.push(
      Prisma.sql`(a.nome ILIKE ${termo} OR a.cpf_cnpj ILIKE ${termo} OR a.telefone ILIKE ${termo})`
    );
  }

  // Só usado pela aba "Todos" de GET /api/associados (ver `listar` — nunca
  // por `resumo`, que já conta "com_cobranca_aberto" à parte via FILTER).
  // Sem isso, um associado que ficou sem nenhuma cobrança pending/overdue
  // (ex.: quitou tudo, ver reconciliação em POST /api/sync) continuava
  // aparecendo na tabela do Dashboard com "R$ 0,00"/"Em dia" mesmo não tendo
  // mais nada em aberto — o card de resumo já não contava esse associado,
  // então a tabela ficava inconsistente com o próprio resumo da tela.
  if (exigirCobrancaAberta) {
    condicoes.push(
      Prisma.sql`EXISTS (SELECT 1 FROM cobrancas c WHERE c.associado_id = a.id AND c.status IN ('pending', 'overdue'))`
    );
  }

  return condicoes;
}

function montarWhereSql(condicoes) {
  return condicoes.length > 0 ? Prisma.sql`WHERE ${Prisma.join(condicoes, ' AND ')}` : Prisma.empty;
}

/**
 * GET /api/associados
 * GET /api/associados?em_negociacao=true|false
 * GET /api/associados?em_juridico=true|false
 * GET /api/associados?bloqueado=true|false
 * GET /api/associados?busca=termo
 * GET /api/associados?page=2&limit=50
 *
 * ⚠️ Resposta paginada — formato diferente de versões anteriores deste
 * endpoint (que retornavam um array na raiz). Veja o README para detalhes
 * dessa mudança.
 *
 * Filtros "em_negociacao", "em_juridico" e "bloqueado" (true ou false cada)
 * combinam entre si com AND. "busca" pesquisa por nome, cpf_cnpj OU
 * telefone (contains, case-insensitive) — é combinada com os demais
 * filtros também via AND.
 *
 * Sem nenhum filtro/busca: cada associado vem com todas as cobranças
 * (qualquer status). Com pelo menos um filtro/busca ativo: só com as
 * cobranças em aberto (status "pending" ou "overdue").
 *
 * ⚠️ Aba "Todos" (nenhum de "em_negociacao"/"em_juridico"/"bloqueado"
 * informado — "busca" sozinho não conta): só retorna associados com **pelo
 * menos uma cobrança pending/overdue** — quem quitou tudo (ver reconciliação
 * em POST /api/sync) não aparece mais aqui, do mesmo jeito que já não é
 * contado em `com_cobranca_aberto` de GET /api/associados/resumo. Assim que
 * QUALQUER um dos três toggles é informado (true OU false), essa exigência
 * desaparece — as abas "Em Negociação"/"Bloqueados"/"Jurídico" continuam
 * mostrando todo mundo marcado com o respectivo toggle, tenha ou não
 * cobrança em aberto (ex.: associado em negociação que já zerou as
 * cobranças, mas ainda está em acompanhamento).
 *
 * Ordenação: pelo "pior" (mais negativo) dias_diferenca entre as cobranças
 * em aberto de cada associado — feita NO BANCO, antes de aplicar a
 * paginação, para garantir que o associado mais crítico do sistema inteiro
 * sempre apareça na página 1 (não é uma ordenação só dentro da página).
 * Associados sem cobrança em aberto (só possível quando algum toggle está
 * ativo — ver acima) vão por último; empates são desempatados por nome (A-Z).
 *
 * Paginação: "page" (padrão 1) e "limit" (padrão 100, máximo 100 — valores
 * maiores são reduzidos para 100, não geram erro). Resposta:
 * { dados: [...], paginacao: { pagina_atual, total_paginas, total_registros, por_pagina } }
 */
exports.listar = async (req, res, next) => {
  try {
    const {
      em_negociacao: emNegociacaoParam,
      em_juridico: emJuridicoParam,
      bloqueado: bloqueadoParam,
      busca,
      page: pageParam,
      limit: limitParam,
    } = req.query;

    const emNegociacaoValido = emNegociacaoParam === 'true' || emNegociacaoParam === 'false';
    const emJuridicoValido = emJuridicoParam === 'true' || emJuridicoParam === 'false';
    const bloqueadoValido = bloqueadoParam === 'true' || bloqueadoParam === 'false';
    const termoBusca = typeof busca === 'string' ? busca.trim() : '';
    const buscaValida = termoBusca !== '';
    const filtroAtivo = emNegociacaoValido || emJuridicoValido || bloqueadoValido || buscaValida;

    let page = parseInt(pageParam, 10);
    if (!Number.isInteger(page) || page < 1) page = 1;

    let limit = parseInt(limitParam, 10);
    if (!Number.isInteger(limit) || limit < 1) limit = LIMITE_PADRAO;
    if (limit > LIMITE_MAXIMO) limit = LIMITE_MAXIMO;

    // Nenhum dos três toggles de status ativo (independente de "busca") =
    // é a aba "Todos" — nesse caso, e só nesse caso, associados sem nenhuma
    // cobrança pending/overdue ficam de fora da lista (ver comentário em
    // `construirCondicoesFiltro`). As abas "Em Negociação"/"Bloqueados"/
    // "Jurídico" continuam mostrando quem está marcado com o respectivo
    // toggle, tenha ou não cobrança em aberto (ex.: associado em negociação
    // que já quitou tudo, mas ainda em acompanhamento).
    const nenhumFiltroDeStatusAtivo = !emNegociacaoValido && !emJuridicoValido && !bloqueadoValido;

    const whereSql = montarWhereSql(
      construirCondicoesFiltro({
        emNegociacaoParam,
        emJuridicoParam,
        bloqueadoParam,
        termoBusca: buscaValida ? termoBusca : '',
        exigirCobrancaAberta: nenhumFiltroDeStatusAtivo,
      })
    );

    const totalRows = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS total FROM associados a ${whereSql}
    `;
    const totalRegistros = totalRows[0]?.total ?? 0;
    const totalPaginas = Math.max(Math.ceil(totalRegistros / limit), 1);

    // 1ª etapa: calcula, no banco, o "pior" dias_diferenca em aberto de cada
    // associado e já aplica ORDER BY + LIMIT/OFFSET — só traz os IDs da
    // página pedida, na ordem certa.
    const paginaOrdenada = await prisma.$queryRaw`
      SELECT
        a.id,
        (
          SELECT MIN(c.dias_diferenca)
          FROM cobrancas c
          WHERE c.associado_id = a.id AND c.status IN ('pending', 'overdue')
        ) AS pior_dias_diferenca
      FROM associados a
      ${whereSql}
      ORDER BY pior_dias_diferenca ASC NULLS LAST, a.nome ASC
      LIMIT ${limit} OFFSET ${(page - 1) * limit}
    `;

    const idsOrdenados = paginaOrdenada.map((row) => row.id);

    // 2ª etapa: busca os registros completos (com cobranças/relacionamentos)
    // só para os IDs da página — depois reordena em memória de acordo com
    // `idsOrdenados`, já que "WHERE id IN (...)" não garante preservar essa
    // ordem no retorno do banco.
    let associadosOrdenados = [];
    if (idsOrdenados.length > 0) {
      const registros = await prisma.associado.findMany({
        where: { id: { in: idsOrdenados } },
        include: {
          cobrancas: {
            where: filtroAtivo ? { status: { in: COBRANCAS_ABERTAS } } : undefined,
            orderBy: { vencimento: 'asc' },
          },
        },
      });

      const porId = new Map(registros.map((r) => [r.id, r]));
      associadosOrdenados = idsOrdenados.map((id) => porId.get(id)).filter(Boolean);
    }

    res.json({
      dados: associadosOrdenados.map(serializeAssociado),
      paginacao: {
        pagina_atual: page,
        total_paginas: totalPaginas,
        total_registros: totalRegistros,
        por_pagina: limit,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/associados/resumo
 * GET /api/associados/resumo?busca=termo
 *
 * Números agregados da carteira (ou do subconjunto filtrado por "busca"),
 * calculados diretamente no banco — nunca traz os registros individuais
 * para a aplicação. Não aceita "em_negociacao"/"em_juridico"/"bloqueado"
 * nem paginação (não fazem sentido para um resultado só de números).
 *
 * Resposta:
 * {
 *   com_cobranca_aberto: number,  // associados com >=1 cobrança pending/overdue
 *   valor_total_aberto: number,   // soma do valor dessas cobranças
 *   em_negociacao: number,
 *   bloqueados: number,
 *   em_juridico: number
 * }
 */
exports.resumo = async (req, res, next) => {
  try {
    const { busca } = req.query;
    const termoBusca = typeof busca === 'string' ? busca.trim() : '';
    const buscaValida = termoBusca !== '';

    const whereSql = montarWhereSql(
      construirCondicoesFiltro({ termoBusca: buscaValida ? termoBusca : '' })
    );

    const [linhas] = await prisma.$queryRaw`
      SELECT
        COUNT(DISTINCT a.id) FILTER (WHERE c.status IN ('pending', 'overdue')) AS com_cobranca_aberto,
        COALESCE(SUM(c.valor) FILTER (WHERE c.status IN ('pending', 'overdue')), 0) AS valor_total_aberto,
        COUNT(DISTINCT a.id) FILTER (WHERE a.em_negociacao = true) AS em_negociacao,
        COUNT(DISTINCT a.id) FILTER (WHERE a.bloqueado = true) AS bloqueados,
        COUNT(DISTINCT a.id) FILTER (WHERE a.em_juridico = true) AS em_juridico
      FROM associados a
      LEFT JOIN cobrancas c ON c.associado_id = a.id
      ${whereSql}
    `;

    res.json({
      com_cobranca_aberto: Number(linhas.com_cobranca_aberto),
      valor_total_aberto: Number(linhas.valor_total_aberto),
      em_negociacao: Number(linhas.em_negociacao),
      bloqueados: Number(linhas.bloqueados),
      em_juridico: Number(linhas.em_juridico),
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/associados/:cpfCnpj
 * Detalhe de um associado, com todas as cobranças e o histórico unificado de
 * status (em_negociacao, bloqueado e em_juridico juntos — ver "historico" em
 * serializeAssociado), do mais recente para o mais antigo.
 */
exports.detalhar = async (req, res, next) => {
  try {
    const { cpfCnpj } = req.params;

    const associado = await prisma.associado.findUnique({
      where: { cpfCnpj },
      include: {
        cobrancas: { orderBy: { vencimento: 'asc' } },
        historicoStatus: { orderBy: { alteradoEm: 'desc' } },
      },
    });

    if (!associado) {
      return res.status(404).json({ error: 'Associado não encontrado.' });
    }

    res.json(serializeAssociado(associado));
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/associados/:cpfCnpj/negociacao
 * Body: { "em_negociacao": true|false, "observacao": "texto opcional" }
 * Atualiza o status de negociação e grava um registro em
 * historico_status_associado (campo = "em_negociacao").
 *
 * "observacao_atualizada_em" é atualizado (para a data/hora atual) somente
 * quando o valor de "observacao" realmente muda neste endpoint — não muda
 * se o body não enviar "observacao", se enviar o mesmo texto já salvo, nem
 * em nenhum outro endpoint (POST /api/sync nunca toca em observacao).
 */
exports.atualizarNegociacao = async (req, res, next) => {
  try {
    const { cpfCnpj } = req.params;
    const { em_negociacao: emNegociacao, observacao } = req.body || {};

    if (typeof emNegociacao !== 'boolean') {
      return res.status(400).json({ error: '"em_negociacao" deve ser true ou false.' });
    }

    const associado = await prisma.associado.findUnique({ where: { cpfCnpj } });

    if (!associado) {
      return res.status(404).json({ error: 'Associado não encontrado.' });
    }

    const novaObservacao = observacao !== undefined ? observacao : associado.observacao;
    const observacaoMudou = novaObservacao !== associado.observacao;

    const [atualizado] = await prisma.$transaction([
      prisma.associado.update({
        where: { cpfCnpj },
        data: {
          emNegociacao,
          observacao: novaObservacao,
          ...(observacaoMudou ? { observacaoAtualizadaEm: new Date() } : {}),
        },
      }),
      prisma.historicoStatusAssociado.create({
        data: {
          associadoId: associado.id,
          campo: 'em_negociacao',
          statusAnterior: associado.emNegociacao,
          statusNovo: emNegociacao,
        },
      }),
    ]);

    res.json(serializeAssociado(atualizado));
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/associados/:cpfCnpj/bloqueio
 * Body: { "bloqueado": true|false }
 * Atualiza o campo e grava um registro em historico_status_associado
 * (campo = "bloqueado").
 */
exports.atualizarBloqueio = async (req, res, next) => {
  try {
    const { cpfCnpj } = req.params;
    const { bloqueado } = req.body || {};

    if (typeof bloqueado !== 'boolean') {
      return res.status(400).json({ error: '"bloqueado" deve ser true ou false.' });
    }

    const associado = await prisma.associado.findUnique({ where: { cpfCnpj } });

    if (!associado) {
      return res.status(404).json({ error: 'Associado não encontrado.' });
    }

    const [atualizado] = await prisma.$transaction([
      prisma.associado.update({
        where: { cpfCnpj },
        data: { bloqueado },
      }),
      prisma.historicoStatusAssociado.create({
        data: {
          associadoId: associado.id,
          campo: 'bloqueado',
          statusAnterior: associado.bloqueado,
          statusNovo: bloqueado,
        },
      }),
    ]);

    res.json(serializeAssociado(atualizado));
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/associados/:cpfCnpj/juridico
 * Body: { "em_juridico": true|false }
 * Atualiza o campo e grava um registro em historico_status_associado
 * (campo = "em_juridico") — diferente das versões anteriores deste endpoint,
 * que não gravavam histórico nenhum para esta mudança.
 */
exports.atualizarJuridico = async (req, res, next) => {
  try {
    const { cpfCnpj } = req.params;
    const { em_juridico: emJuridico } = req.body || {};

    if (typeof emJuridico !== 'boolean') {
      return res.status(400).json({ error: '"em_juridico" deve ser true ou false.' });
    }

    const associado = await prisma.associado.findUnique({ where: { cpfCnpj } });

    if (!associado) {
      return res.status(404).json({ error: 'Associado não encontrado.' });
    }

    const [atualizado] = await prisma.$transaction([
      prisma.associado.update({
        where: { cpfCnpj },
        data: { emJuridico },
      }),
      prisma.historicoStatusAssociado.create({
        data: {
          associadoId: associado.id,
          campo: 'em_juridico',
          statusAnterior: associado.emJuridico,
          statusNovo: emJuridico,
        },
      }),
    ]);

    res.json(serializeAssociado(atualizado));
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/associados/:cpfCnpj/bloqueios/contador
 * Conta quantas vezes o associado foi marcado como bloqueado
 * (historico_status_associado com campo = "bloqueado" e status_novo = true)
 * desde o último reset (associados.ciclo_resetado_em). Sem reset prévio,
 * conta o histórico todo.
 */
exports.contadorBloqueios = async (req, res, next) => {
  try {
    const { cpfCnpj } = req.params;

    const associado = await prisma.associado.findUnique({ where: { cpfCnpj } });

    if (!associado) {
      return res.status(404).json({ error: 'Associado não encontrado.' });
    }

    const contador = await prisma.historicoStatusAssociado.count({
      where: {
        associadoId: associado.id,
        campo: 'bloqueado',
        statusNovo: true,
        ...(associado.cicloResetadoEm ? { alteradoEm: { gt: associado.cicloResetadoEm } } : {}),
      },
    });

    res.json({
      cpf_cnpj: associado.cpfCnpj,
      contador,
      ciclo_resetado_em: associado.cicloResetadoEm,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/associados/:cpfCnpj/bloqueios/resetar
 * Marca um novo ponto de corte (ciclo_resetado_em = agora), sem apagar
 * os registros antigos de historico_bloqueio.
 */
exports.resetarBloqueios = async (req, res, next) => {
  try {
    const { cpfCnpj } = req.params;

    const associado = await prisma.associado.findUnique({ where: { cpfCnpj } });

    if (!associado) {
      return res.status(404).json({ error: 'Associado não encontrado.' });
    }

    const atualizado = await prisma.associado.update({
      where: { cpfCnpj },
      data: { cicloResetadoEm: new Date() },
    });

    res.json({
      cpf_cnpj: atualizado.cpfCnpj,
      ciclo_resetado_em: atualizado.cicloResetadoEm,
    });
  } catch (err) {
    next(err);
  }
};
