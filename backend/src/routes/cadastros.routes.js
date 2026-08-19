const { Router } = require('express');
const auth = require('../middleware/auth');
const ctrl = require('../controllers/cadastros.controller');

const router = Router();

router.post('/cadastros', auth, ctrl.criar);
router.get('/cadastros', auth, ctrl.listar);

module.exports = router;
