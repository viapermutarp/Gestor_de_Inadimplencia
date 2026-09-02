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
// Ajuste "Super Admin pode adicionar mais de 1 usuário numa franquia" (ver
// docs/plano-multi-franquia.md, seção 8, item 8) — usuário EXTRA numa
// franquia já existente, distinto do usuário titular criado junto com
// POST /franquias.
router.post('/franquias/:id/usuarios', auth, exigirSuperAdmin, ctrl.criarUsuarioExtra);
// Ajuste "Excluir franquia permanentemente" (ALTO RISCO) — hard delete
// definitivo, distinto do PATCH .../ativo (reversível). Ver docblock de
// ctrl.excluirPermanentemente pra lista completa do que é apagado e pela
// exigência de confirmar_nome no body.
router.delete('/franquias/:id/excluir-permanente', auth, exigirSuperAdmin, ctrl.excluirPermanentemente);

module.exports = router;
