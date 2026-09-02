const { Router } = require('express');
const auth = require('../middleware/auth');
const escopoFranquia = require('../middleware/escopoFranquia');
const ctrl = require('../controllers/contratos.controller');

const router = Router();

router.get('/contratos', auth, escopoFranquia, ctrl.listar);
router.get('/contratos/:id', auth, escopoFranquia, ctrl.obter);
router.post('/contratos', auth, escopoFranquia, ctrl.criar);
router.patch('/contratos/:id', auth, escopoFranquia, ctrl.atualizar);
router.delete('/contratos/:id', auth, escopoFranquia, ctrl.remover);

module.exports = router;
