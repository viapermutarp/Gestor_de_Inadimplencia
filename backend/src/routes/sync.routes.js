const { Router } = require('express');
const auth = require('../middleware/auth');
const escopoFranquia = require('../middleware/escopoFranquia');
const exigirRecurso = require('../middleware/exigirRecurso');
const { sync, atualizarSobDemanda } = require('../controllers/sync.controller');

const router = Router();

// "dashboard": POST /sync/atualizar é o botão "Atualizar" da tela Dashboard
// (sessão JWT). POST /sync em si é usado pelo n8n via API key — sempre
// isento (ver exigirRecurso.js), então esta restrição nunca afeta a
// integração externa, só uma eventual chamada via sessão de usuário.
const dashboard = exigirRecurso('dashboard');

router.post('/sync', auth, dashboard, escopoFranquia, sync);
router.post('/sync/atualizar', auth, dashboard, escopoFranquia, atualizarSobDemanda);

module.exports = router;
