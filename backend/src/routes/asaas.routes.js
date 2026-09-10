const { Router } = require('express');
const ctrl = require('../controllers/asaasWebhook.controller');

const router = Router();

// Sem "auth"/"escopoFranquia" de propósito — o Asaas não manda
// "Authorization: Bearer" (ver docblock do controller para o esquema de
// autenticação real: franquiaId na URL + token no header
// "asaas-access-token").
router.post('/asaas/webhook/:franquiaId', ctrl.receber);

module.exports = router;
