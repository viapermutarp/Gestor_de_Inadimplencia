const { Router } = require('express');
const auth = require('../middleware/auth');
const escopoFranquia = require('../middleware/escopoFranquia');
const exigirRecurso = require('../middleware/exigirRecurso');
const { sync, atualizarSobDemanda, reconciliarCobrancasQuitadas } = require('../controllers/sync.controller');

const router = Router();

// "dashboard": POST /sync/atualizar é o botão "Atualizar" da tela Dashboard
// (sessão JWT). POST /sync em si é usado pelo n8n via API key — sempre
// isento (ver exigirRecurso.js), então esta restrição nunca afeta a
// integração externa, só uma eventual chamada via sessão de usuário. Mesma
// isenção vale pra POST /sync/reconciliar-cobrancas-quitadas (AJUSTE 18) —
// pensado pra ser chamado por um workflow n8n agendado (API key), não por
// sessão de usuário.
const dashboard = exigirRecurso('dashboard');

router.post('/sync', auth, dashboard, escopoFranquia, sync);
router.post('/sync/atualizar', auth, dashboard, escopoFranquia, atualizarSobDemanda);
router.post('/sync/reconciliar-cobrancas-quitadas', auth, dashboard, escopoFranquia, reconciliarCobrancasQuitadas);

module.exports = router;
