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

// Tamanho mínimo aceito pra qualquer senha definida por aqui (criação de
// usuário de franquia, reset de senha, troca de senha do próprio
// SUPER_ADMIN) — mesmo valor nos 3 fluxos, um único lugar pra mudar.
const SENHA_TAMANHO_MINIMO = 8;

function senhaValida(senha) {
  return typeof senha === 'string' && senha.length >= SENHA_TAMANHO_MINIMO;
}

/**
 * Multi-franquia — Etapa 5 ("Controle Geral") e ajuste "Super Admin pode
 * adicionar mais de 1 usuário numa franquia" (ver
 * docs/plano-multi-franquia.md, seção 8, item 8). Cria um usuário
 * "FRANQUIA" (ver seção 1.2 do plano — papel simplificado pra 2 valores)
 * vinculado a uma Franquia — chamado tanto de dentro da transação que cria
 * a Franquia (ver franquias.controller.js:criar, pro usuário titular)
 * quanto isoladamente pra adicionar um usuário EXTRA a uma franquia já
 * existente (ver franquias.controller.js:criarUsuarioExtra). Desde que a
 * trava @@unique([franquiaId]) foi removida do model Usuario, chamar isto
 * mais de uma vez pra mesma franquia é esperado e suportado — cada
 * chamada só precisa de um "recursosPermitidos" próprio (não herda nada da
 * franquia nem de outro usuário dela). Lança um erro com "status: 409" se
 * o email já estiver em uso — a trava real é o "@unique" do banco em
 * "usuarios.email" (único GLOBALMENTE, não por franquia).
 */
async function criarUsuarioFranquia({ franquiaId, nome, email, senha, recursosPermitidos }, tx = prisma) {
  const senhaHash = await bcrypt.hash(senha, BCRYPT_CUSTO);
  try {
    return await tx.usuario.create({
      data: { nome, email, senhaHash, papel: 'FRANQUIA', franquiaId, ativo: true, recursosPermitidos },
    });
  } catch (err) {
    if (err.code === 'P2002') {
      throw Object.assign(new Error('Já existe um usuário com esse e-mail.'), { status: 409 });
    }
    throw err;
  }
}

/**
 * Multi-franquia — Etapa 5. O SUPER_ADMIN define uma senha nova pra
 * qualquer usuário (POST /api/usuarios/:id/resetar-senha), sem precisar
 * saber a antiga. Não é a mesma coisa que "trocar a própria senha" (ver
 * `atualizarCredenciaisProprias` abaixo) — aqui não existe "senha atual"
 * pra confirmar, porque quem está autorizando é o SUPER_ADMIN, não o dono
 * da conta.
 */
async function resetarSenha(usuarioId, novaSenha) {
  const senhaHash = await bcrypt.hash(novaSenha, BCRYPT_CUSTO);
  return prisma.usuario.update({ where: { id: usuarioId }, data: { senhaHash } });
}

/**
 * Multi-franquia — Etapa 5, item 5 do escopo ("SUPER_ADMIN edita as
 * próprias credenciais"). Troca nome/email/senha do PRÓPRIO usuário
 * autenticado — ao contrário de `resetarSenha` (ação do SUPER_ADMIN sobre
 * OUTRO usuário), aqui sempre exige a senha atual antes de aplicar
 * qualquer mudança (nome, email OU senha), mesmo trocando só o nome — é
 * uma única rota de "confirme quem você é antes de mudar algo na sua
 * conta", mais simples de raciocinar do que ter regras diferentes por
 * campo. "email"/"senhaNova" são opcionais (só entra no update o que foi
 * informado); "nome" idem.
 */
async function atualizarCredenciaisProprias(usuarioId, { nome, email, senhaAtual, senhaNova }) {
  const usuario = await prisma.usuario.findUnique({ where: { id: usuarioId } });
  if (!usuario) {
    throw Object.assign(new Error('Usuário não encontrado.'), { status: 404 });
  }

  const senhaOk = await verificarSenha(usuario, senhaAtual);
  if (!senhaOk) {
    throw Object.assign(new Error('Senha atual incorreta.'), { status: 401 });
  }

  const data = {};
  if (nome !== undefined) data.nome = nome;
  if (email !== undefined) data.email = email;
  if (senhaNova !== undefined) data.senhaHash = await bcrypt.hash(senhaNova, BCRYPT_CUSTO);

  try {
    return await prisma.usuario.update({ where: { id: usuarioId }, data });
  } catch (err) {
    if (err.code === 'P2002') {
      throw Object.assign(new Error('Já existe um usuário com esse e-mail.'), { status: 409 });
    }
    throw err;
  }
}

module.exports = {
  seedSuperAdminSeNecessario,
  buscarPorEmail,
  verificarSenha,
  atualizarUltimoLogin,
  emailAdminPadrao,
  criarUsuarioFranquia,
  resetarSenha,
  atualizarCredenciaisProprias,
  senhaValida,
  SENHA_TAMANHO_MINIMO,
  // Exportados só pra uso em testes.
  pareceEmail,
  BCRYPT_CUSTO,
};
