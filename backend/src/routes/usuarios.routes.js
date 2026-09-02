const { Router } = require('express');
const auth = require('../middleware/auth');
const exigirSuperAdmin = require('../middleware/exigirSuperAdmin');
const ctrl = require('../controllers/usuarios.controller');

const router = Router();

// Bloquear/desbloquear, trocar telas liberadas e resetar senha de OUTRO
// usuário — só SUPER_ADMIN.
router.patch('/usuarios/:id', auth, exigirSuperAdmin, ctrl.atualizar);
router.post('/usuarios/:id/resetar-senha', auth, exigirSuperAdmin, ctrl.resetarSenha);

// /api/perfil — as PRÓPRIAS credenciais de quem está logado. Não exige
// SUPER_ADMIN (qualquer sessão de painel pode ver/editar os próprios
// dados) — hoje só usado pela tela de Controle Geral (só o SUPER_ADMIN tem
// acesso a essa tela), mas a rota em si não depende disso.
router.get('/perfil', auth, ctrl.obterPerfil);
router.patch('/perfil', auth, ctrl.atualizarPerfil);

module.exports = router;
