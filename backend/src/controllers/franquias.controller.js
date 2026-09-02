const prisma = require('../config/prisma');
const refreshTokens = require('../services/refreshTokens.service');
const { criarUsuarioFranquia, pareceEmail, senhaValida, SENHA_TAMANHO_MINIMO } = require('../services/usuarios.service');
const { RECURSOS } = require('../config/recursos');

function campoPreenchido(valor) {
  return typeof valor === 'string' && valor.trim() !== '';
}

/**
 * Restrição de telas por USUÁRIO (ver docs/plano-multi-franquia.md, seção
 * 8, item 8). Valida um array de chaves de recurso — todas precisam estar
 * em RECURSOS (ver src/config/recursos.js) e sem duplicatas. `undefined` é
 * aceito (significa "não informado" — quem chama decide o default: criar()
 * e criarUsuarioExtra() usam a lista completa por padrão).
 */
function recursosValidos(recursos) {
  if (!Array.isArray(recursos)) return false;
  const unicos = new Set(recursos);
  return unicos.size === recursos.length && recursos.every((r) => RECURSOS.includes(r));
}

/**
 * Multi-franquia — Etapa 5 ("Controle Geral", seção 6 do plano) e ajuste
 * "Super Admin pode adicionar mais de 1 usuário numa franquia" (seção 8,
 * item 8): desde que a trava @@unique([franquiaId]) foi removida do model
 * Usuario, a serialização passa a embutir TODOS os usuários da franquia
 * (array, não mais um objeto único) — a tela não precisa de uma segunda
 * chamada nem de uma rota separada pra "usuários" (ver escopo combinado no
 * pedido: "pode ser mostrado junto da lista de franquias"). Cada usuário
 * já traz "recursos_permitidos" PRÓPRIO (movido de
 * Franquia.recursosPermitidos — ver docblock legado no schema.prisma), por
 * isso a franquia em si não expõe mais um "recursos_permitidos" no nível
 * dela.
 *
 * "usuarios: []" acontece pra franquias que nunca passaram por
 * POST /api/franquias nem por POST /api/franquias/:id/usuarios — hoje, na
 * prática, só a franquia semeada pela migração da Fase 1 ("Via Permuta
 * Ribeirão Preto"), que nasceu antes do model Usuario existir e nunca
 * teve um usuário "FRANQUIA" vinculado a ela. O frontend trata esse caso
 * mostrando "Nenhum usuário vinculado" em vez de quebrar.
 */
function serializeUsuarioDaFranquia(usuario) {
  return {
    id: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    ativo: usuario.ativo,
    ultimo_login_em: usuario.ultimoLoginEm,
    recursos_permitidos: usuario.recursosPermitidos,
  };
}

function serializeFranquia(franquia) {
  const usuarios = Array.isArray(franquia.usuarios) ? franquia.usuarios : [];
  return {
    id: franquia.id,
    nome: franquia.nome,
    ativo: franquia.ativo,
    criado_em: franquia.criadoEm,
    usuarios: usuarios.map(serializeUsuarioDaFranquia),
  };
}

/**
 * GET /api/franquias — lista todas as franquias (ativas e inativas), mais
 * antigas primeiro (a franquia padrão sempre aparece no topo), cada uma já
 * com TODOS os usuários dela embutidos (mais antigo primeiro — o titular,
 * quando existe, sempre aparece antes dos usuários extras adicionados
 * depois). Só SUPER_ADMIN (ver middleware/exigirSuperAdmin.js).
 */
exports.listar = async (req, res, next) => {
  try {
    const franquias = await prisma.franquia.findMany({
      orderBy: { criadoEm: 'asc' },
      include: { usuarios: { orderBy: { criadoEm: 'asc' } } },
    });
    res.json(franquias.map(serializeFranquia));
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/franquias — body { nome, usuario: { nome, email, senha },
 * recursos_permitidos? }. Cria a franquia E o usuário TITULAR dela numa
 * única transação — não existe fluxo de criar uma franquia "vazia" sem
 * usuário (ver escopo da Etapa 5, item 2): se a criação do usuário falhar
 * (ex.: email já em uso por outra franquia), a franquia também não é
 * criada (rollback). Pra adicionar usuários EXTRAS a uma franquia já
 * existente, ver POST /api/franquias/:id/usuarios (exports.criarUsuarioExtra
 * abaixo).
 */
exports.criar = async (req, res, next) => {
  try {
    const { nome, usuario, recursos_permitidos: recursosPermitidos } = req.body || {};
    const erros = [];

    if (!campoPreenchido(nome)) erros.push('"nome" da franquia é obrigatório.');
    if (!usuario || typeof usuario !== 'object') {
      erros.push('"usuario" (nome, email, senha) é obrigatório.');
    } else {
      if (!campoPreenchido(usuario.nome)) erros.push('"usuario.nome" é obrigatório.');
      if (!pareceEmail(usuario.email)) erros.push('"usuario.email" precisa ser um e-mail válido.');
      if (!senhaValida(usuario.senha)) {
        erros.push(`"usuario.senha" precisa ter pelo menos ${SENHA_TAMANHO_MINIMO} caracteres.`);
      }
    }

    // Restrição de telas por USUÁRIO (movido de Franquia — ver escopo do
    // ajuste "Super Admin pode adicionar mais de 1 usuário numa franquia").
    // "recursos_permitidos" é opcional na criação — sem ele, o usuário
    // titular nasce com TODOS os recursos liberados por padrão (mesmo
    // default que os checkboxes já vêm marcados no frontend); se
    // informado, precisa ser um array só com chaves válidas de RECURSOS.
    const listaRecursos = recursosPermitidos === undefined ? RECURSOS : recursosPermitidos;
    if (!recursosValidos(listaRecursos)) {
      erros.push(`"recursos_permitidos" precisa ser um array só com estas chaves (sem repetir): ${RECURSOS.join(', ')}.`);
    }

    if (erros.length > 0) {
      return res.status(400).json({ error: erros.join(' ') });
    }

    const resultado = await prisma.$transaction(async (tx) => {
      const franquia = await tx.franquia.create({ data: { nome: nome.trim() } });
      const usuarioCriado = await criarUsuarioFranquia(
        {
          franquiaId: franquia.id,
          nome: usuario.nome.trim(),
          email: usuario.email.trim(),
          senha: usuario.senha,
          recursosPermitidos: listaRecursos,
        },
        tx
      );
      return { ...franquia, usuarios: [usuarioCriado] };
    });

    res.status(201).json(serializeFranquia(resultado));
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/franquias/:id/usuarios — body { nome, email, senha,
 * recursos_permitidos? }. Multi-franquia — ajuste "Super Admin pode
 * adicionar mais de 1 usuário numa franquia" (ver
 * docs/plano-multi-franquia.md, seção 8, item 8). Diferente de
 * POST /api/franquias (que cria franquia + usuário titular juntos), aqui a
 * franquia JÁ EXISTE — só nasce mais um login pra ela, compartilhando as
 * integrações da franquia (Asaas/webhook/Drive, todas já por-franquia) mas
 * com "recursos_permitidos" (telas liberadas) PRÓPRIOS, independentes dos
 * outros usuários dela. Mesma validação de email único GLOBALMENTE que já
 * vale pro usuário titular (constraint do banco em usuarios.email — ver
 * usuarios.service.js:criarUsuarioFranquia).
 */
exports.criarUsuarioExtra = async (req, res, next) => {
  try {
    const franquia = await prisma.franquia.findUnique({ where: { id: req.params.id } });
    if (!franquia) {
      return res.status(404).json({ error: 'Franquia não encontrada.' });
    }

    const { nome, email, senha, recursos_permitidos: recursosPermitidos } = req.body || {};
    const erros = [];

    if (!campoPreenchido(nome)) erros.push('"nome" é obrigatório.');
    if (!pareceEmail(email)) erros.push('"email" precisa ser um e-mail válido.');
    if (!senhaValida(senha)) erros.push(`"senha" precisa ter pelo menos ${SENHA_TAMANHO_MINIMO} caracteres.`);

    const listaRecursos = recursosPermitidos === undefined ? RECURSOS : recursosPermitidos;
    if (!recursosValidos(listaRecursos)) {
      erros.push(`"recursos_permitidos" precisa ser um array só com estas chaves (sem repetir): ${RECURSOS.join(', ')}.`);
    }

    if (erros.length > 0) {
      return res.status(400).json({ error: erros.join(' ') });
    }

    const usuarioCriado = await criarUsuarioFranquia({
      franquiaId: franquia.id,
      nome: nome.trim(),
      email: email.trim(),
      senha,
      recursosPermitidos: listaRecursos,
    });

    res.status(201).json(serializeUsuarioDaFranquia(usuarioCriado));
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/franquias/:id — body: qualquer subconjunto de { nome, ativo }.
 * "recursos_permitidos" NÃO é mais aceito aqui (movido pra Usuario — ver
 * escopo do ajuste "Super Admin pode adicionar mais de 1 usuário numa
 * franquia"); pra mudar as telas liberadas de um usuário específico, ver
 * PATCH /api/usuarios/:id (usuarios.controller.js).
 *
 * Desativar (`ativo: false`) bloqueia o login de TODOS os usuários da
 * franquia IMEDIATAMENTE (não só o titular — desde que uma franquia pode
 * ter N usuários) — o próprio POST /api/login e POST /api/refresh já
 * checam "usuario.franquia.ativo" a cada tentativa (ver
 * auth.controller.js, refreshTokens.service.js:rotacionar), então isso já
 * vale sem nenhuma ação extra aqui. Complementarmente, revoga também
 * todas as sessões já abertas de CADA usuário da franquia (mesmo
 * mecanismo usado ao bloquear um usuário individual — ver
 * usuarios.controller.js) — sem isso, um refresh token já emitido e ainda
 * não usado só seria barrado na PRÓXIMA tentativa de renovação, não
 * imediatamente; revogar fecha essa janela pra todos de uma vez.
 */
exports.atualizar = async (req, res, next) => {
  try {
    const existente = await prisma.franquia.findUnique({ where: { id: req.params.id }, include: { usuarios: true } });
    if (!existente) {
      return res.status(404).json({ error: 'Franquia não encontrada.' });
    }

    const { nome, ativo } = req.body || {};
    const data = {};
    const erros = [];

    if (nome !== undefined) {
      if (!campoPreenchido(nome)) erros.push('"nome" não pode ser vazio.');
      else data.nome = nome.trim();
    }
    if (ativo !== undefined) {
      if (typeof ativo !== 'boolean') erros.push('"ativo" deve ser booleano.');
      else data.ativo = ativo;
    }

    if (erros.length > 0) {
      return res.status(400).json({ error: erros.join(' ') });
    }

    const franquia = await prisma.franquia.update({
      where: { id: req.params.id },
      data,
      include: { usuarios: { orderBy: { criadoEm: 'asc' } } },
    });

    if (ativo === false) {
      await Promise.all(existente.usuarios.map((u) => refreshTokens.revogarTodasDoUsuario(u.id)));
    }

    res.json(serializeFranquia(franquia));
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/franquias/:id/excluir-permanente — ALTO RISCO: hard delete
 * definitivo da franquia e de TODO dado vinculado a ela dentro do Gestor
 * (ver escopo do ajuste "Excluir franquia permanentemente"). Diferente de
 * `atualizar` com `ativo: false` (reversível, só bloqueia login — ver
 * docblock acima), aqui a franquia e as linhas abaixo são apagadas de
 * verdade, sem chance de desfazer:
 *   - usuários (titular + extras)
 *   - associados/cadastros — e, em cascata (onDelete: Cascade no schema,
 *     ver models Cobranca/HistoricoStatusAssociado/CardJuridico), as
 *     cobranças, o histórico de status do associado e os cards jurídicos
 *     vinculados a cada um
 *   - cards e etapas do Kanban Jurídico (inclusive os cards "livres", não
 *     vinculados a nenhum associado)
 *   - histórico de cards jurídicos (historico_card_juridico — sem FK pra
 *     card/usuário, de propósito, ver docblock do model no schema, mas TEM
 *     franquia_id direto, então também precisa ser apagado explicitamente
 *     aqui)
 *   - configurações, chaves de API, logs de sincronização, cadastros
 *     enviados (fluxo de Cadastro/Faturamento) e modelos de contrato
 *   - cobranças ignoradas do cálculo de Taxa de Inadimplência
 *
 * Essa é a lista COMPLETA de tabelas com "franquia_id" hoje no schema —
 * conferida direto no model Franquia (relações .usuarios/.associados/
 * .cadastrosEnviados/.modelosContrato/.cobrancasIgnoradas/.syncLogs/
 * .apiKeys/.configuracoes/.etapasJuridico/.cardsJuridico/
 * .historicosCardJuridico — 11 relações, batendo uma a uma com os 11
 * deleteMany abaixo) mais as duas tabelas ESCOPO_RELACAO que não têm
 * franquia_id próprio (Cobranca e HistoricoStatusAssociado, vinculadas via
 * Associado — ver prismaComEscopo.js). Se um model novo ganhar
 * "franquiaId" no futuro, ele PRECISA ser adicionado aqui também — senão a
 * exclusão vai falhar com erro de FK (a maioria das relações pra Franquia é
 * onDelete: Restrict por padrão, só EtapaJuridico->CardJuridico e
 * Associado->{Cobranca,HistoricoStatusAssociado,CardJuridico} são Cascade)
 * em vez de silenciosamente deixar dado órfão pra trás.
 *
 * NÃO apaga nada fora do Gestor: nenhuma chamada é feita pro Asaas, Bling
 * ou Google Drive — as contas/credenciais externas da franquia continuam
 * existindo e intactas nesses serviços, só o registro delas (e de tudo
 * mais) some daqui de dentro. Isso fica explícito também na resposta (ver
 * "aviso" abaixo), pro frontend exibir pro usuário.
 *
 * Confirmação de duas etapas: além do `exigirSuperAdmin` de sempre, exige
 * `confirmar_nome` no body batendo EXATAMENTE (depois de `.trim()`) com o
 * nome atual da franquia — mesmo padrão do "delete repo" do GitHub (digitar
 * o nome pra confirmar), pra tornar impossível excluir a franquia errada
 * por engano/clique duplo. A checagem acontece ANTES de abrir a transação.
 *
 * Tudo numa única transação (tudo ou nada): se qualquer passo falhar (ex.:
 * uma tabela nova com franquia_id que ainda não foi adicionada aqui,
 * estourando um erro de FK), a transação inteira é revertida e nada é
 * apagado.
 */
exports.excluirPermanentemente = async (req, res, next) => {
  try {
    const franquia = await prisma.franquia.findUnique({ where: { id: req.params.id } });
    if (!franquia) {
      return res.status(404).json({ error: 'Franquia não encontrada.' });
    }

    const confirmarNome = typeof req.body?.confirmar_nome === 'string' ? req.body.confirmar_nome.trim() : '';
    if (confirmarNome !== franquia.nome) {
      return res.status(400).json({
        error: 'Nome de confirmação não confere. Digite exatamente o nome da franquia pra confirmar a exclusão permanente.',
      });
    }

    const franquiaId = franquia.id;

    const registrosApagados = await prisma.$transaction(async (tx) => {
      // Kanban Jurídico: cards antes das etapas (EtapaJuridico->CardJuridico
      // é onDelete: Cascade no schema, mas apagamos explícito pra não
      // depender só disso — ver docblock acima).
      const cardsJuridico = await tx.cardJuridico.deleteMany({ where: { franquiaId } });
      const etapasJuridico = await tx.etapaJuridico.deleteMany({ where: { franquiaId } });

      // Histórico do Jurídico — franquia_id direto, sem FK pra card/usuário
      // (sobrevive de propósito à exclusão do card em uso normal; aqui
      // apagamos junto porque é a FRANQUIA inteira que está sumindo).
      const historicoCardJuridico = await tx.historicoCardJuridico.deleteMany({ where: { franquiaId } });

      // ESCOPO_RELACAO (sem franquia_id próprio, filtrados via relação com
      // Associado) — onDelete: Cascade no schema já faria isso sozinho ao
      // apagar o Associado logo abaixo; apagamos explícito mesmo assim,
      // pra não depender só do cascade do banco numa operação irreversível.
      const cobrancas = await tx.cobranca.deleteMany({ where: { associado: { franquiaId } } });
      const historicoStatusAssociado = await tx.historicoStatusAssociado.deleteMany({
        where: { associado: { franquiaId } },
      });

      const associados = await tx.associado.deleteMany({ where: { franquiaId } });

      const configuracoes = await tx.configuracao.deleteMany({ where: { franquiaId } });
      const apiKeys = await tx.apiKey.deleteMany({ where: { franquiaId } });
      const syncLogs = await tx.syncLog.deleteMany({ where: { franquiaId } });
      const cadastrosEnviados = await tx.cadastroEnviado.deleteMany({ where: { franquiaId } });
      const modelosContrato = await tx.modeloContrato.deleteMany({ where: { franquiaId } });
      const cobrancasIgnoradas = await tx.cobrancaIgnorada.deleteMany({ where: { franquiaId } });

      const usuarios = await tx.usuario.deleteMany({ where: { franquiaId } });

      await tx.franquia.delete({ where: { id: franquiaId } });

      return {
        usuarios: usuarios.count,
        associados: associados.count,
        cobrancas: cobrancas.count,
        historico_status_associado: historicoStatusAssociado.count,
        cards_juridico: cardsJuridico.count,
        etapas_juridico: etapasJuridico.count,
        historico_card_juridico: historicoCardJuridico.count,
        configuracoes: configuracoes.count,
        api_keys: apiKeys.count,
        sync_logs: syncLogs.count,
        cadastros_enviados: cadastrosEnviados.count,
        modelos_contrato: modelosContrato.count,
        cobrancas_ignoradas: cobrancasIgnoradas.count,
      };
    });

    res.json({
      excluido: true,
      franquia: { id: franquiaId, nome: franquia.nome },
      registros_apagados: registrosApagados,
      aviso:
        'Exclusão permanente dentro do Gestor de Inadimplência. Contas e dados em serviços externos (Asaas, Bling, Google Drive) NÃO são apagados automaticamente — continuam existindo e precisam ser encerrados/removidos manualmente nesses serviços, se for o caso.',
    });
  } catch (err) {
    next(err);
  }
};
