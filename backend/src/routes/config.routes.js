const { Router } = require('express');
const auth = require('../middleware/auth');
const ctrl = require('../controllers/config.controller');

const router = Router();

router.get('/config/api-keys', auth, ctrl.listarApiKeys);
router.post('/config/api-keys', auth, ctrl.criarApiKey);
router.post('/config/api-keys/:id/revogar', auth, ctrl.revogarApiKey);
router.get('/config/webhook-cadastro', auth, ctrl.obterWebhookCadastro);
router.patch('/config/webhook-cadastro', auth, ctrl.atualizarWebhookCadastro);
router.get('/config/asaas-key', auth, ctrl.obterAsaasKey);
router.patch('/config/asaas-key', auth, ctrl.atualizarAsaasKey);
router.get('/config/palavras-excluidas', auth, ctrl.obterPalavrasExcluidas);
router.patch('/config/palavras-excluidas', auth, ctrl.atualizarPalavrasExcluidas);
router.get('/config/tolerancia-dias', auth, ctrl.obterToleranciaDias);
router.patch('/config/tolerancia-dias', auth, ctrl.atualizarToleranciaDias);
router.get('/config/sync-log', auth, ctrl.syncLog);

module.exports = router;
