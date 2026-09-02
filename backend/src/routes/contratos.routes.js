const { Router } = require('express');
const auth = require('../middleware/auth');
const escopoFranquia = require('../middleware/escopoFranquia');
const exigirRecurso = require('../middleware/exigirRecurso');
const ctrl = require('../controllers/contratos.controller');

const router = Router();

const contratos = exigirRecurso('contratos');

router.get('/contratos', auth, contratos, escopoFranquia, ctrl.listar);
router.get('/contratos/:id', auth, contratos, escopoFranquia, ctrl.obter);
router.post('/contratos', auth, contratos, escopoFranquia, ctrl.criar);
router.patch('/contratos/:id', auth, contratos, escopoFranquia, ctrl.atualizar);
router.delete('/contratos/:id', auth, contratos, escopoFranquia, ctrl.remover);

module.exports = router;
