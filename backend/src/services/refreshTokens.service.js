const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const prisma = require('../config/prisma');
const env = require('../config/env');

/**
 * Sessão do painel = access token curto (JWT, stateless) + refresh token
 * opaco (string aleatória, guardada hasheada no banco, como ApiKey). Ver
 * "Autenticação: access token curto + refresh token" no README pro
 * diagnóstico do bug que motivou essa troca (o login antigo emitia só um
 * JWT de vida longa e determinístico — mesmas credenciais no mesmo segundo
 * geravam o MESMO token, e não existia nenhum jeito de revogar uma sessão
 * antes da expiração).
 *
 * O access token carrega um claim "jti" = id do RefreshToken da sessão que
 * o originou. Isso garante duas coisas: (1) dois logins nunca produzem o
 * mesmo access token, mesmo com as mesmas credenciais no mesmo segundo,
 * porque cada sessão tem um jti novo (uuid); (2) dá pra, no futuro,
 * verificar no meio do caminho (antes do access token expirar) se aquela
 * sessão específica foi revogada — hoje o middleware não faz essa checagem
 * por request (manteria o JWT stateless/rápido), mas o refresh sempre
 * checa, então revogar uma sessão bloqueia o usuário assim que o access
 * token atual expirar (few minutes, não dias).
 *
 * Multi-franquia, Fase 2, Passo 2 (ver docs/plano-multi-franquia.md, seção
 * 2, e a conversa que aprovou este desenho): o campo "usuario" desta
 * tabela NÃO mudou de forma — continua uma coluna de texto livre, sem
 * migração de schema. O que mudou é o que ele guarda: a partir de agora,
 * sempre o `id` (uuid) de um `Usuario`, nunca mais um nome de login cru.
 * Isso foi escolhido deliberadamente em vez de renomear a coluna pra
 * "usuario_id" com uma migração de backfill — o mesmo padrão de risco que
 * causou o incidente pós-deploy da Fase 1 (mudar a forma de uma coluna
 * que código existente já lê, exigindo todo esse código ser atualizado no
 * mesmo passo). Sem schema novo, o efeito é limpo e previsível: uma sessão
 * criada ANTES deste deploy tem "usuario" = a string crua do login antigo
 * (ex.: "admin") — `rotacionar` abaixo não acha nenhum `Usuario` com esse
 * `id` e trata como sessão inválida (401, mesmo caminho de "sessão
 * expirada/revogada" que já existe). Como o access token já é curto
 * (`JWT_EXPIRES_IN`, 15min por padrão), o efeito prático é: toda sessão
 * ativa antes do deploy pede um login novo dentro de, no máximo, 15
 * minutos — uma vez, esperado, sem perda de dado nem de nenhuma
 * funcionalidade (diferente do incidente da Fase 1, que foi silencioso).
 */

function gerarHash(valor) {
  return crypto.createHash('sha256').update(String(valor), 'utf8').digest('hex');
}

/**
 * `usuario`: o registro completo de `Usuario` (precisa de `id`, `papel`,
 * `franquiaId`) — não mais uma string crua. O access token passa a
 * carregar `papel`/`franquiaId` como claims, usados a partir da Fase 3
 * pela extension de isolamento.
 *
 * "recursosPermitidos" (restrição de telas por franquia — ver escopo do
 * pedido, item 2, e src/config/recursos.js): só entra no token quando
 * `usuario.franquia` já vem carregado (login/refresh sempre incluem essa
 * relação — ver usuarios.service.js:buscarPorEmail e
 * refreshTokens.service.js:rotacionar), e fica de fora pro SUPER_ADMIN
 * (sem franquia própria, sempre irrestrito). É SÓ UX no frontend (ver
 * lib/auth.js:getClaims — decide o que mostrar no menu, nunca decide
 * acesso de verdade) — a mesma ressalva de "papel"/"franquiaId": um valor
 * aqui pode ficar desatualizado até o token expirar (JWT_EXPIRES_IN, 15min
 * por padrão) se o SUPER_ADMIN mudar os recursos da franquia no meio da
 * sessão; a proteção real é sempre o backend (middleware/exigirRecurso.js),
 * que consulta o banco a cada requisição, nunca confia neste claim.
 */
function gerarAccessToken(usuario, jti) {
  return jwt.sign(
    {
      sub: usuario.id,
      papel: usuario.papel,
      franquiaId: usuario.franquiaId,
      recursosPermitidos: usuario.franquia ? usuario.franquia.recursosPermitidos : undefined,
      jti,
    },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn }
  );
}

/**
 * Cria uma sessão nova: um RefreshToken (persistido, hasheado, guardando
 * o id do Usuario) + um access token cujo "jti" aponta pra ele. Usado
 * tanto no login quanto na rotação do refresh (ver `rotacionar`).
 */
async function criarSessao(usuario) {
  const refreshTokenValor = crypto.randomBytes(48).toString('hex');
  const expiraEm = new Date(Date.now() + env.refreshTokenTtlDias * 24 * 60 * 60 * 1000);

  const registro = await prisma.refreshToken.create({
    data: {
      tokenHash: gerarHash(refreshTokenValor),
      usuario: usuario.id,
      expiraEm,
    },
  });

  const accessToken = gerarAccessToken(usuario, registro.id);

  return {
    accessToken,
    refreshToken: refreshTokenValor,
    expiraEm: env.jwtExpiresIn,
  };
}

/**
 * POST /api/refresh — troca um refresh token válido (existente, não
 * revogado, não expirado, e cujo Usuario associado ainda existe e está
 * ativo — junto com a franquia dele, se tiver uma) por uma sessão nova:
 * revoga o refresh token usado e cria outro (rotação — um refresh token
 * só pode ser trocado uma vez; se alguém tentar reusar um já trocado, cai
 * no `null` abaixo). Retorna null se o token não existir, já tiver sido
 * revogado, estiver expirado, ou se o Usuario dono da sessão não existir
 * mais / estiver desativado / a franquia dele estiver desativada — em
 * todos os casos, quem chama decide como reagir (o controller responde
 * 401, pedindo login de novo).
 */
async function rotacionar(refreshTokenValor) {
  const registro = await prisma.refreshToken.findUnique({
    where: { tokenHash: gerarHash(refreshTokenValor) },
  });

  if (!registro) return null;
  if (registro.revogadoEm) return null;
  if (registro.expiraEm.getTime() < Date.now()) return null;

  await prisma.refreshToken.update({
    where: { id: registro.id },
    data: { revogadoEm: new Date(), ultimoUsoEm: new Date() },
  });

  // "registro.usuario" é o id do Usuario dono da sessão (ver nota no topo
  // do arquivo). Sessões criadas antes deste deploy guardam a string crua
  // do login antigo (ex.: "admin"), que nunca bate com nenhum id de
  // Usuario — cai em "não encontrado" abaixo, tratado como sessão
  // inválida, de propósito.
  const usuario = await prisma.usuario.findUnique({
    where: { id: registro.usuario },
    include: { franquia: true },
  });

  if (!usuario) return null;
  if (!usuario.ativo) return null;
  if (usuario.franquia && !usuario.franquia.ativo) return null;

  return criarSessao(usuario);
}

/**
 * POST /api/logout — revoga só a sessão indicada (idempotente: chamar de
 * novo, ou com um token já revogado/inexistente, não é erro — o objetivo
 * final, "essa sessão não funciona mais", já está garantido).
 */
async function revogar(refreshTokenValor) {
  const registro = await prisma.refreshToken.findUnique({
    where: { tokenHash: gerarHash(refreshTokenValor) },
  });
  if (!registro || registro.revogadoEm) return;

  await prisma.refreshToken.update({
    where: { id: registro.id },
    data: { revogadoEm: new Date() },
  });
}

/**
 * Revoga TODAS as sessões ativas de um usuário — ainda não exposta por
 * nenhum endpoint (chega na Fase 3, junto com a tela de Controle Geral),
 * mas é exatamente o que "desativar um usuário" vai chamar: revogar todos
 * os refresh tokens dele barra login de novo imediatamente, e os access
 * tokens já emitidos ainda funcionam até expirar sozinhos (minutos, não
 * dias — ver JWT_EXPIRES_IN). Note que revogar já não é estritamente
 * necessário pra bloquear o acesso — `rotacionar` acima já nega o refresh
 * de um Usuario com `ativo: false` — mas revogar também garante que
 * qualquer refresh token ainda não usado desse usuário fica invalidado de
 * uma vez, sem depender dele tentar renovar pra ser barrado.
 *
 * "usuarioId": o `id` do Usuario (mesmo valor guardado em
 * "refresh_tokens.usuario" a partir da Fase 2 — ver nota no topo do
 * arquivo). Renomeado de "usuario" pra deixar isso explícito.
 */
async function revogarTodasDoUsuario(usuarioId) {
  await prisma.refreshToken.updateMany({
    where: { usuario: usuarioId, revogadoEm: null },
    data: { revogadoEm: new Date() },
  });
}

module.exports = {
  criarSessao,
  rotacionar,
  revogar,
  revogarTodasDoUsuario,
  // Exportados só pra uso em testes.
  gerarHash,
  gerarAccessToken,
};
