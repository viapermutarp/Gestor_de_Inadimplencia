const { Router } = require('express');
const auth = require('../middleware/auth');
const { sync } = require('../controllers/sync.controller');

const router = Router();

router.post('/sync', auth, sync);

module.exports = router;
