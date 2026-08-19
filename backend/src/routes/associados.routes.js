const { Router } = require('express');
const auth = require('../middleware/auth');
const ctrl = require('../controllers/associados.controller');

const router = Router();

router.get('/associados', auth, ctrl.listar);
router.get('/associados/resumo', auth, ctrl.resumo);
router.get('/associados/:cpfCnpj', auth, ctrl.detalhar);
router.patch('/associados/:cpfCnpj/negociacao', auth, ctrl.atualizarNegociacao);
router.patch('/associados/:cpfCnpj/bloqueio', auth, ctrl.atualizarBloqueio);
router.patch('/associados/:cpfCnpj/juridico', auth, ctrl.atualizarJuridico);
router.get('/associados/:cpfCnpj/bloqueios/contador', auth, ctrl.contadorBloqueios);
router.post('/associados/:cpfCnpj/bloqueios/resetar', auth, ctrl.resetarBloqueios);

module.exports = router;
