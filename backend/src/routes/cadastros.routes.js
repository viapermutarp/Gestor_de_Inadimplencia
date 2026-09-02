const { Router } = require('express');
const auth = require('../middleware/auth');
const escopoFranquia = require('../middleware/escopoFranquia');
const exigirRecurso = require('../middleware/exigirRecurso');
const ctrl = require('../controllers/cadastros.controller');

const router = Router();

const cadastro = exigirRecurso('cadastro');

router.post('/cadastros', auth, cadastro, escopoFranquia, ctrl.criar);
router.get('/cadastros', auth, cadastro, escopoFranquia, ctrl.listar);

module.exports = router;
