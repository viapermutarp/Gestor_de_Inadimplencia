const { Router } = require('express');
const { login, refresh, logout } = require('../controllers/auth.controller');

const router = Router();

// Rotas públicas (sem exigir API key/JWT) — /refresh e /logout usam o
// refresh token em si como credencial (ver auth.controller.js).
router.post('/login', login);
router.post('/refresh', refresh);
router.post('/logout', logout);

module.exports = router;
