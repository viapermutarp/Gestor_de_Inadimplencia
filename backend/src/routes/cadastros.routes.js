const { Router } = require('express');
const auth = require('../middleware/auth');
const escopoFranquia = require('../middleware/escopoFranquia');
const ctrl = require('../controllers/cadastros.controller');

const router = Router();

router.post('/cadastros', auth, escopoFranquia, ctrl.criar);
router.get('/cadastros', auth, escopoFranquia, ctrl.listar);

module.exports = router;
