const { Router } = require('express');
const auth = require('../middleware/auth');
const escopoFranquia = require('../middleware/escopoFranquia');
const exigirRecurso = require('../middleware/exigirRecurso');
const ctrl = require('../controllers/config.controller');

const router = Router();

const configuracoes = exigirRecurso('configuracoes');

router.get('/config/api-keys', auth, configuracoes, escopoFranquia, ctrl.listarApiKeys);
router.post('/config/api-keys', auth, configuracoes, escopoFranquia, ctrl.criarApiKey);
router.post('/config/api-keys/:id/revogar', auth, configuracoes, escopoFranquia, ctrl.revogarApiKey);
router.get('/config/webhook-cadastro', auth, configuracoes, escopoFranquia, ctrl.obterWebhookCadastro);
router.patch('/config/webhook-cadastro', auth, configuracoes, escopoFranquia, ctrl.atualizarWebhookCadastro);
router.get('/config/asaas-key', auth, configuracoes, escopoFranquia, ctrl.obterAsaasKey);
router.patch('/config/asaas-key', auth, configuracoes, escopoFranquia, ctrl.atualizarAsaasKey);
router.get('/config/palavras-excluidas', auth, configuracoes, escopoFranquia, ctrl.obterPalavrasExcluidas);
router.patch('/config/palavras-excluidas', auth, configuracoes, escopoFranquia, ctrl.atualizarPalavrasExcluidas);
router.get('/config/tolerancia-dias', auth, configuracoes, escopoFranquia, ctrl.obterToleranciaDias);
router.patch('/config/tolerancia-dias', auth, configuracoes, escopoFranquia, ctrl.atualizarToleranciaDias);
router.get('/config/drive-pasta-raiz', auth, configuracoes, escopoFranquia, ctrl.obterDrivePastaRaiz);
router.patch('/config/drive-pasta-raiz', auth, configuracoes, escopoFranquia, ctrl.atualizarDrivePastaRaiz);
router.get('/config/google-service-account', auth, configuracoes, escopoFranquia, ctrl.obterGoogleServiceAccount);
router.patch('/config/google-service-account', auth, configuracoes, escopoFranquia, ctrl.atualizarGoogleServiceAccount);
router.get('/config/sync-log', auth, configuracoes, escopoFranquia, ctrl.syncLog);

module.exports = router;
