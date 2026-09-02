const { Router } = require('express');
const auth = require('../middleware/auth');
const escopoFranquia = require('../middleware/escopoFranquia');
const exigirRecurso = require('../middleware/exigirRecurso');
const ctrl = require('../controllers/juridico.controller');

const router = Router();

const juridico = exigirRecurso('juridico');

router.get('/juridico/etapas', auth, juridico, escopoFranquia, ctrl.listarEtapas);
router.post('/juridico/etapas', auth, juridico, escopoFranquia, ctrl.criarEtapa);
router.post('/juridico/etapas/reordenar', auth, juridico, escopoFranquia, ctrl.reordenarEtapas);
router.patch('/juridico/etapas/:id', auth, juridico, escopoFranquia, ctrl.atualizarEtapa);
router.delete('/juridico/etapas/:id', auth, juridico, escopoFranquia, ctrl.removerEtapa);

router.get('/juridico/associados-busca', auth, juridico, escopoFranquia, ctrl.buscarAssociados);

router.post('/juridico/cards', auth, juridico, escopoFranquia, ctrl.criarCard);
router.patch('/juridico/cards/:id', auth, juridico, escopoFranquia, ctrl.atualizarCard);
router.patch('/juridico/cards/:id/mover', auth, juridico, escopoFranquia, ctrl.moverCard);
router.get('/juridico/cards/:id/historico', auth, juridico, escopoFranquia, ctrl.listarHistoricoCard);
router.delete('/juridico/cards/:id', auth, juridico, escopoFranquia, ctrl.removerCard);

module.exports = router;
