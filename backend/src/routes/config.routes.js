const { Router } = require('express');
const auth = require('../middleware/auth');
const escopoFranquia = require('../middleware/escopoFranquia');
const ctrl = require('../controllers/config.controller');

const router = Router();

router.get('/config/api-keys', auth, escopoFranquia, ctrl.listarApiKeys);
router.post('/config/api-keys', auth, escopoFranquia, ctrl.criarApiKey);
router.post('/config/api-keys/:id/revogar', auth, escopoFranquia, ctrl.revogarApiKey);
router.get('/config/webhook-cadastro', auth, escopoFranquia, ctrl.obterWebhookCadastro);
router.patch('/config/webhook-cadastro', auth, escopoFranquia, ctrl.atualizarWebhookCadastro);
router.get('/config/asaas-key', auth, escopoFranquia, ctrl.obterAsaasKey);
router.patch('/config/asaas-key', auth, escopoFranquia, ctrl.atualizarAsaasKey);
router.get('/config/palavras-excluidas', auth, escopoFranquia, ctrl.obterPalavrasExcluidas);
router.patch('/config/palavras-excluidas', auth, escopoFranquia, ctrl.atualizarPalavrasExcluidas);
router.get('/config/tolerancia-dias', auth, escopoFranquia, ctrl.obterToleranciaDias);
router.patch('/config/tolerancia-dias', auth, escopoFranquia, ctrl.atualizarToleranciaDias);
router.get('/config/drive-pasta-raiz', auth, escopoFranquia, ctrl.obterDrivePastaRaiz);
router.patch('/config/drive-pasta-raiz', auth, escopoFranquia, ctrl.atualizarDrivePastaRaiz);
router.get('/config/sync-log', auth, escopoFranquia, ctrl.syncLog);

module.exports = router;
