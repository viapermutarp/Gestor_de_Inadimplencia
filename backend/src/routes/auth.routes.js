const { Router } = require('express');
const { login } = require('../controllers/auth.controller');

const router = Router();

// POST /api/login — única rota pública (sem exigir API key/JWT)
router.post('/login', login);

module.exports = router;
