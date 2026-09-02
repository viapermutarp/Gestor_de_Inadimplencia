const { Router } = require('express');
const auth = require('../middleware/auth');
const escopoFranquia = require('../middleware/escopoFranquia');
const exigirRecurso = require('../middleware/exigirRecurso');
const ctrl = require('../controllers/inadimplencia.controller');

const router = Router();

const inadimplencia = exigirRecurso('inadimplencia');

router.get('/inadimplencia/resumo', auth, inadimplencia, escopoFranquia, ctrl.resumo);
router.get('/inadimplencia/evolucao-mensal', auth, inadimplencia, escopoFranquia, ctrl.evolucaoMensal);
router.get('/inadimplencia/exclusoes', auth, inadimplencia, escopoFranquia, ctrl.listarExclusoes);
router.post('/inadimplencia/exclusoes', auth, inadimplencia, escopoFranquia, ctrl.criarExclusao);
router.delete('/inadimplencia/exclusoes/:id', auth, inadimplencia, escopoFranquia, ctrl.removerExclusao);

module.exports = router;
