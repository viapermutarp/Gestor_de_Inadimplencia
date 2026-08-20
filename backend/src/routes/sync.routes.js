const { Router } = require('express');
const auth = require('../middleware/auth');
const { sync, atualizarSobDemanda } = require('../controllers/sync.controller');

const router = Router();

router.post('/sync', auth, sync);
router.post('/sync/atualizar', auth, atualizarSobDemanda);

module.exports = router;
