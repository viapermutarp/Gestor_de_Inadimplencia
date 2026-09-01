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
 */

function gerarHash(valor) {
  return crypto.createHash('sha256').update(String(valor), 'utf8').digest('hex');
}

function gerarAccessToken(usuario, jti) {
  return jwt.sign({ sub: usuario, jti }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
}

/**
 * Cria uma sessão nova: um RefreshToken (persistido, hasheado) + um access
 * token cujo "jti" aponta pra ele. Usado tanto no login quanto na rotação
 * do refresh (ver `rotacionar`).
 */
async function criarSessao(usuario) {
  const refreshTokenValor = crypto.randomBytes(48).toString('hex');
  const expiraEm = new Date(Date.now() + env.refreshTokenTtlDias * 24 * 60 * 60 * 1000);

  const registro = await prisma.refreshToken.create({
    data: {
      tokenHash: gerarHash(refreshTokenValor),
      usuario,
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
 * revogado, não expirado) por uma sessão nova: revoga o refresh token
 * usado e cria outro (rotação — um refresh token só pode ser trocado uma
 * vez; se alguém tentar reusar um já trocado, cai no `null` abaixo e é
 * tratado como sessão inválida, já que o valor original não existe mais
 * ativo no banco). Retorna null se o token não existir, já tiver sido
 * revogado, ou estiver expirado — quem chama decide como reagir (o
 * controller responde 401, pedindo login de novo).
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

  return criarSessao(registro.usuario);
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
 * nenhum endpoint (não há multi-usuário hoje), mas é exatamente o que o
 * futuro "bloquear acesso" do item 2 (multi-franquia) vai chamar quando um
 * usuário for desativado: revogar todos os refresh tokens dele barra login
 * de novo imediatamente, e os access tokens já emitidos ainda funcionam
 * até expirar sozinhos (minutos, não dias — ver JWT_EXPIRES_IN).
 */
async function revogarTodasDoUsuario(usuario) {
  await prisma.refreshToken.updateMany({
    where: { usuario, revogadoEm: null },
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
