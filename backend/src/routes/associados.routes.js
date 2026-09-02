const { Router } = require('express');
const auth = require('../middleware/auth');
const escopoFranquia = require('../middleware/escopoFranquia');
const ctrl = require('../controllers/associados.controller');

const router = Router();

router.get('/associados', auth, escopoFranquia, ctrl.listar);
router.get('/associados/resumo', auth, escopoFranquia, ctrl.resumo);
router.get('/associados/:cpfCnpj', auth, escopoFranquia, ctrl.detalhar);
router.patch('/associados/:cpfCnpj/negociacao', auth, escopoFranquia, ctrl.atualizarNegociacao);
router.patch('/associados/:cpfCnpj/bloqueio', auth, escopoFranquia, ctrl.atualizarBloqueio);
router.patch('/associados/:cpfCnpj/juridico', auth, escopoFranquia, ctrl.atualizarJuridico);
router.get('/associados/:cpfCnpj/bloqueios/contador', auth, escopoFranquia, ctrl.contadorBloqueios);
router.post('/associados/:cpfCnpj/bloqueios/resetar', auth, escopoFranquia, ctrl.resetarBloqueios);

module.exports = router;
