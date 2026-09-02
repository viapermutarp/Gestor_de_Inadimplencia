const { Router } = require('express');
const auth = require('../middleware/auth');
const exigirSuperAdmin = require('../middleware/exigirSuperAdmin');
const ctrl = require('../controllers/franquias.controller');

const router = Router();

// Multi-franquia — Etapa 5 ("Controle Geral"). Sem "escopoFranquia" de
// propósito: Franquia não é um model tenant-scoped (não está na lista de
// ESCOPO_DIRETO/ESCOPO_RELACAO de prismaComEscopo.js) — essas rotas
// operam globalmente, através do client Prisma comum, protegidas só por
// "exigirSuperAdmin".
router.get('/franquias', auth, exigirSuperAdmin, ctrl.listar);
router.post('/franquias', auth, exigirSuperAdmin, ctrl.criar);
router.patch('/franquias/:id', auth, exigirSuperAdmin, ctrl.atualizar);

module.exports = router;
