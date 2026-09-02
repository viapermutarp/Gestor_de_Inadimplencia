const { Router } = require('express');
const auth = require('../middleware/auth');
const escopoFranquia = require('../middleware/escopoFranquia');
const exigirRecurso = require('../middleware/exigirRecurso');
const ctrl = require('../controllers/associados.controller');

const router = Router();

// Restrição de telas por franquia: todo este arquivo pertence à tela
// Dashboard (inclui o toggle "em_juridico" do próprio associado — não
// confundir com a aba nova "Jurídico"/Kanban, que é um recurso separado,
// ver juridico.routes.js).
const dashboard = exigirRecurso('dashboard');

router.get('/associados', auth, dashboard, escopoFranquia, ctrl.listar);
router.get('/associados/resumo', auth, dashboard, escopoFranquia, ctrl.resumo);
router.get('/associados/:cpfCnpj', auth, dashboard, escopoFranquia, ctrl.detalhar);
router.patch('/associados/:cpfCnpj/negociacao', auth, dashboard, escopoFranquia, ctrl.atualizarNegociacao);
router.patch('/associados/:cpfCnpj/bloqueio', auth, dashboard, escopoFranquia, ctrl.atualizarBloqueio);
router.patch('/associados/:cpfCnpj/juridico', auth, dashboard, escopoFranquia, ctrl.atualizarJuridico);
router.get('/associados/:cpfCnpj/bloqueios/contador', auth, dashboard, escopoFranquia, ctrl.contadorBloqueios);
router.post('/associados/:cpfCnpj/bloqueios/resetar', auth, dashboard, escopoFranquia, ctrl.resetarBloqueios);

module.exports = router;
