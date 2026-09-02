const { Router } = require('express');
const auth = require('../middleware/auth');
const escopoFranquia = require('../middleware/escopoFranquia');
const ctrl = require('../controllers/inadimplencia.controller');

const router = Router();

router.get('/inadimplencia/resumo', auth, escopoFranquia, ctrl.resumo);
router.get('/inadimplencia/evolucao-mensal', auth, escopoFranquia, ctrl.evolucaoMensal);
router.get('/inadimplencia/exclusoes', auth, escopoFranquia, ctrl.listarExclusoes);
router.post('/inadimplencia/exclusoes', auth, escopoFranquia, ctrl.criarExclusao);
router.delete('/inadimplencia/exclusoes/:id', auth, escopoFranquia, ctrl.removerExclusao);

module.exports = router;
