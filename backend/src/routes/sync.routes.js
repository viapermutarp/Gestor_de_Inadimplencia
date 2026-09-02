const { Router } = require('express');
const auth = require('../middleware/auth');
const escopoFranquia = require('../middleware/escopoFranquia');
const { sync, atualizarSobDemanda } = require('../controllers/sync.controller');

const router = Router();

router.post('/sync', auth, escopoFranquia, sync);
router.post('/sync/atualizar', auth, escopoFranquia, atualizarSobDemanda);

module.exports = router;
