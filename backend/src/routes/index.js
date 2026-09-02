const { Router } = require('express');
const authRoutes = require('./auth.routes');
const syncRoutes = require('./sync.routes');
const associadosRoutes = require('./associados.routes');
const configRoutes = require('./config.routes');
const cadastrosRoutes = require('./cadastros.routes');
const inadimplenciaRoutes = require('./inadimplencia.routes');
const contratosRoutes = require('./contratos.routes');
const franquiasRoutes = require('./franquias.routes');
const usuariosRoutes = require('./usuarios.routes');
const juridicoRoutes = require('./juridico.routes');

const router = Router();

router.use('/api', authRoutes);
router.use('/api', syncRoutes);
router.use('/api', associadosRoutes);
router.use('/api', configRoutes);
router.use('/api', cadastrosRoutes);
router.use('/api', inadimplenciaRoutes);
router.use('/api', contratosRoutes);
router.use('/api', franquiasRoutes);
router.use('/api', usuariosRoutes);
router.use('/api', juridicoRoutes);

module.exports = router;
