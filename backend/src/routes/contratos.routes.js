const { Router } = require('express');
const auth = require('../middleware/auth');
const ctrl = require('../controllers/contratos.controller');

const router = Router();

router.get('/contratos', auth, ctrl.listar);
router.get('/contratos/:id', auth, ctrl.obter);
router.post('/contratos', auth, ctrl.criar);
router.patch('/contratos/:id', auth, ctrl.atualizar);
router.delete('/contratos/:id', auth, ctrl.remover);

module.exports = router;
