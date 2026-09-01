const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');
const env = require('../config/env');

// Custo do bcrypt — 12 é o padrão recomendado atualmente (equilíbrio entre
// segurança e tempo de hash), mesmo valor citado no plano multi-franquia.
const BCRYPT_CUSTO = 12;

function pareceEmail(valor) {
  return typeof valor === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valor);
}

/**
 * Email que o SUPER_ADMIN migrado recebe quando ADMIN_USER não parece um
 * email válido (ex.: "admin" -> "admin@local"). Extraído numa função só
 * pra `seedSuperAdminSeNecessario` (que grava) e `auth.controller.js`
 * (que precisa achar esse usuário de novo quando o operador digita o
 * ADMIN_USER de sempre no login, não o email derivado — ver comentário em
 * `login` no controller) usarem exatamente a mesma regra, sem duplicar.
 */
function emailAdminPadrao() {
  return pareceEmail(env.adminUser) ? env.adminUser : `${env.adminUser}@local`;
}

/**
 * Fase 2 do multi-franquia (ver docs/plano-multi-franquia.md, seção 2) —
 * Passo 1: semeia o primeiro `Usuario` (papel SUPER_ADMIN, sem franquia) a
 * partir de ADMIN_USER/ADMIN_PASSWORD, na primeira subida depois desta
 * mudança. Idempotente e silenciosa quanto a corridas: se `usuarios` já
 * tiver qualquer registro (inclusive um criado manualmente, ou por outro
 * processo subindo ao mesmo tempo), não faz nada.
 *
 * IMPORTANTE — isto é só o Passo 1: por enquanto `POST /api/login` continua
 * comparando direto contra ADMIN_USER/ADMIN_PASSWORD (não lê `usuarios`
 * ainda). Este passo só garante que, quando o Passo 2 (login via `Usuario`)
 * for aprovado e implementado, já vai existir um SUPER_ADMIN pronto — sem
 * isso, o primeiro login depois do Passo 2 cairia direto no fallback
 * break-glass, o que também funcionaria, mas semear antes é mais previsível
 * e permite testar o Passo 1 isoladamente, sem tocar no fluxo de login.
 *
 * `email`: se ADMIN_USER já parecer um e-mail válido, usa como está; senão,
 * usa "<ADMIN_USER>@local" (editável depois pela tela de Controle Geral,
 * quando existir — não trava nada).
 */
async function seedSuperAdminSeNecessario() {
  const total = await prisma.usuario.count();
  if (total > 0) return null;

  const email = emailAdminPadrao();
  const senhaHash = await bcrypt.hash(env.adminPassword, BCRYPT_CUSTO);

  try {
    const usuario = await prisma.usuario.create({
      data: {
        nome: 'Administrador',
        email,
        senhaHash,
        papel: 'SUPER_ADMIN',
        franquiaId: null,
        ativo: true,
      },
    });
    console.log(`[usuarios] SUPER_ADMIN semeado automaticamente (email: ${email}).`);
    return usuario;
  } catch (err) {
    // Corrida entre 2 processos subindo ao mesmo tempo (violação do
    // @unique em "email") — não é um erro real, o resultado desejado
    // ("existe um SUPER_ADMIN") já está garantido pelo outro processo.
    if (err.code === 'P2002') return null;
    throw err;
  }
}

/**
 * POST /api/login (Fase 2, Passo 2) — busca um Usuario pelo email, com a
 * franquia já carregada (usada logo em seguida pra checar franquia.ativo,
 * sem precisar de uma segunda consulta). Retorna null se não existir —
 * quem chama decide o que fazer (401, ou tentar o fallback break-glass).
 */
async function buscarPorEmail(email) {
  if (!email) return null;
  return prisma.usuario.findUnique({ where: { email }, include: { franquia: true } });
}

/** Compara a senha em texto puro contra o hash bcrypt salvo do usuário. */
async function verificarSenha(usuario, senha) {
  if (!usuario?.senhaHash) return false;
  return bcrypt.compare(String(senha), usuario.senhaHash);
}

/**
 * Atualiza "ultimo_login_em" depois de um login bem-sucedido —
 * best-effort, chamada sem `await` bloquear a resposta (mesmo padrão já
 * usado em apiKeys.service.js pro "ultimo_uso_em" de uma API key).
 */
async function atualizarUltimoLogin(usuarioId) {
  await prisma.usuario.update({ where: { id: usuarioId }, data: { ultimoLoginEm: new Date() } });
}

module.exports = {
  seedSuperAdminSeNecessario,
  buscarPorEmail,
  verificarSenha,
  atualizarUltimoLogin,
  emailAdminPadrao,
  // Exportados só pra uso em testes.
  pareceEmail,
  BCRYPT_CUSTO,
};
