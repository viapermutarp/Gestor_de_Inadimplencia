const crypto = require('crypto');
const prisma = require('../config/prisma');
const { getApiKey } = require('./config.service');
const { obterFranquiaIdPadrao } = require('./franquiaPadrao.service');

const CARACTERES_VISIVEIS = 6;

function gerarHash(chave) {
  return crypto.createHash('sha256').update(String(chave), 'utf8').digest('hex');
}

function mascarar(tamanho, ultimosCaracteres) {
  const bullets = Math.max(tamanho - ultimosCaracteres.length, 0);
  return '•'.repeat(bullets) + ultimosCaracteres;
}

/**
 * Importa a antiga chave única (tabela "configuracoes", chave "api_key" —
 * ver getApiKey em config.service.js, que também cai para a variável de
 * ambiente API_KEY quando a tabela está vazia) para a nova tabela
 * "api_keys", na primeira vez que alguém lista ou valida chaves depois
 * desta migração, caso a tabela ainda esteja vazia. Idempotente e
 * silenciosa: garante que integrações já configuradas com a chave antiga
 * (ex.: automações no n8n) não param de funcionar, sem exigir nenhum passo
 * manual do usuário. Nunca lança — se a importação falhar (ex.: corrida
 * entre duas requisições simultâneas batendo na trava única de "hash"),
 * a chamada só segue adiante sem a chave legada.
 */
async function migrarChaveLegadaSeNecessario() {
  const total = await prisma.apiKey.count();
  if (total > 0) return;

  let chaveLegada;
  try {
    chaveLegada = await getApiKey();
  } catch {
    return;
  }
  if (!chaveLegada) return;

  try {
    const franquiaId = await obterFranquiaIdPadrao();
    await prisma.apiKey.create({
      data: {
        franquiaId,
        nome: 'Chave padrão (migrada)',
        hash: gerarHash(chaveLegada),
        tamanho: chaveLegada.length,
        ultimosCaracteres: chaveLegada.slice(-CARACTERES_VISIVEIS),
      },
    });
  } catch (err) {
    // Corrida com outra requisição concorrente (violação do @unique em
    // "hash") — ignora, não é um erro real.
    if (err.code !== 'P2002') throw err;
  }
}

/**
 * POST /api/config/api-keys — gera uma chave aleatória forte, salva só o
 * hash (SHA-256) e os últimos CARACTERES_VISIVEIS caracteres (usados
 * depois só pra mascarar na listagem) e retorna a chave completa — única
 * vez que ela aparece por inteiro em qualquer resposta.
 *
 * Multi-franquia — Fase 3: recebe o client já escopado da requisição
 * ("prismaCliente" — normalmente "req.prisma") e o "franquiaId" explícito
 * resolvido pelo controller (ver config.controller.js:
 * "req.auth.franquiaId" pra um usuário normal; pro SUPER_ADMIN sem
 * "?franquia_id=" na query — cenário de hoje, só 1 franquia — cai no
 * fallback de "franquiaPadrao.service.js", igual ao comportamento anterior
 * à Fase 3). Grava "franquiaId" explicitamente nos dados sempre — funciona
 * tanto com um client escopado (a extension confirma que bate) quanto com o
 * client base/irrestrito do SUPER_ADMIN (que não injeta nada sozinho).
 */
async function criarChave(prismaCliente, franquiaId, nome) {
  const chave = crypto.randomBytes(32).toString('hex');
  const registro = await prismaCliente.apiKey.create({
    data: {
      franquiaId,
      nome,
      hash: gerarHash(chave),
      tamanho: chave.length,
      ultimosCaracteres: chave.slice(-CARACTERES_VISIVEIS),
    },
  });

  return {
    id: registro.id,
    nome: registro.nome,
    chave,
    criada_em: registro.criadaEm,
  };
}

/**
 * GET /api/config/api-keys — lista as chaves (ativas e revogadas) da
 * franquia da requisição, mais recentes primeiro, sempre mascaradas.
 * "prismaCliente" (normalmente "req.prisma") já vem escopado — sem "where"
 * nenhum aqui, o isolamento é automático (ver prismaComEscopo.js).
 */
async function listarChaves(prismaCliente) {
  await migrarChaveLegadaSeNecessario();

  const registros = await prismaCliente.apiKey.findMany({ orderBy: { criadaEm: 'desc' } });

  return registros.map((r) => ({
    id: r.id,
    nome: r.nome,
    chave_mascarada: mascarar(r.tamanho, r.ultimosCaracteres),
    criada_em: r.criadaEm,
    ultimo_uso_em: r.ultimoUsoEm,
    ativa: r.revogadaEm === null,
  }));
}

/**
 * POST /api/config/api-keys/:id/revogar — marca a chave como revogada
 * (nunca deleta a linha, pra manter histórico). Idempotente: revogar uma
 * chave já revogada não é erro. Retorna null se o id não existir NESSA
 * franquia, pro controller responder 404 (mesmo se o id existir em outra
 * franquia — "prismaCliente" escopado trata os dois casos como "não
 * encontrado", sem diferenciar, pra nunca vazar que o id existe alhures).
 */
async function revogarChave(prismaCliente, id) {
  const registro = await prismaCliente.apiKey.findUnique({ where: { id } });
  if (!registro) return null;

  if (registro.revogadaEm) {
    return { id: registro.id, nome: registro.nome, ativa: false };
  }

  const atualizado = await prismaCliente.apiKey.update({
    where: { id },
    data: { revogadaEm: new Date() },
  });

  return { id: atualizado.id, nome: atualizado.nome, ativa: false };
}

/**
 * Usada pelo middleware de autenticação (ver src/middleware/auth.js) —
 * aceita qualquer chave ativa (não revogada) da lista, no lugar da antiga
 * comparação contra uma chave única. Atualiza "ultimo_uso_em" em segundo
 * plano (sem bloquear a resposta) quando a chave é válida — best-effort,
 * um erro aqui não deve derrubar a requisição que está sendo autenticada.
 *
 * Multi-franquia — Fase 3: retorna `{ franquiaId }` (não mais só
 * true/false) — é o que permite ao middleware montar "req.prisma" escopado
 * pela franquia da PRÓPRIA chave usada (ver prismaComEscopo.js e seção 4 do
 * plano: "sync/cadastros, autenticados por API key, recebem req.prisma
 * escopado pela franquiaId da própria ApiKey usada"). Retorna `null` se a
 * chave não existir ou estiver revogada — usa sempre o client BASE
 * (não-escopado), nunca `req.prisma`, porque essa checagem acontece ANTES
 * de "req.prisma" existir (é ela quem decide qual franquia usar).
 */
async function validarChave(token) {
  await migrarChaveLegadaSeNecessario();

  const registro = await prisma.apiKey.findUnique({ where: { hash: gerarHash(token) } });
  if (!registro || registro.revogadaEm) return null;

  prisma.apiKey
    .update({ where: { id: registro.id }, data: { ultimoUsoEm: new Date() } })
    .catch((err) => console.error('[apiKeys] Erro ao atualizar último uso:', err.message));

  return { franquiaId: registro.franquiaId };
}

module.exports = {
  criarChave,
  listarChaves,
  revogarChave,
  validarChave,
  // Exportados só pra uso em testes.
  gerarHash,
  mascarar,
};
