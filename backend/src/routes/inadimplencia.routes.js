const { Router } = require('express');
const auth = require('../middleware/auth');
const ctrl = require('../controllers/inadimplencia.controller');

const router = Router();

router.get('/inadimplencia/resumo', auth, ctrl.resumo);
router.get('/inadimplencia/evolucao-mensal', auth, ctrl.evolucaoMensal);
router.get('/inadimplencia/exclusoes', auth, ctrl.listarExclusoes);
router.post('/inadimplencia/exclusoes', auth, ctrl.criarExclusao);
router.delete('/inadimplencia/exclusoes/:id', auth, ctrl.removerExclusao);

module.exports = router;
