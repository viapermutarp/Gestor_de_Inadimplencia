const { Router } = require('express');
const auth = require('../middleware/auth');
const escopoFranquia = require('../middleware/escopoFranquia');
const exigirRecurso = require('../middleware/exigirRecurso');
const ctrl = require('../controllers/juridico.controller');
const ctrlDocs = require('../controllers/juridicoDocumentos.controller');

const router = Router();

const juridico = exigirRecurso('juridico');

router.get('/juridico/etapas', auth, juridico, escopoFranquia, ctrl.listarEtapas);
router.post('/juridico/etapas', auth, juridico, escopoFranquia, ctrl.criarEtapa);
router.post('/juridico/etapas/reordenar', auth, juridico, escopoFranquia, ctrl.reordenarEtapas);
router.patch('/juridico/etapas/:id', auth, juridico, escopoFranquia, ctrl.atualizarEtapa);
router.delete('/juridico/etapas/:id', auth, juridico, escopoFranquia, ctrl.removerEtapa);

router.get('/juridico/associados-busca', auth, juridico, escopoFranquia, ctrl.buscarAssociados);

router.post('/juridico/cards', auth, juridico, escopoFranquia, ctrl.criarCard);
router.patch('/juridico/cards/:id', auth, juridico, escopoFranquia, ctrl.atualizarCard);
router.patch('/juridico/cards/:id/mover', auth, juridico, escopoFranquia, ctrl.moverCard);
router.get('/juridico/cards/:id/historico', auth, juridico, escopoFranquia, ctrl.listarHistoricoCard);
router.delete('/juridico/cards/:id', auth, juridico, escopoFranquia, ctrl.removerCard);

// Documentos anexados ao associado, visíveis no card Jurídico (AJUSTE 11) —
// vinculados por "cpfCnpj", não por "cardId" (sobrevivem à exclusão do
// card, ver docblock do model DocumentoJuridico em schema.prisma). Mesmo
// recurso "juridico", sem permissão nova (ver escopo do pedido).
router.post(
  '/juridico/associados/:cpfCnpj/documentos',
  auth,
  juridico,
  escopoFranquia,
  ctrlDocs.uploadMiddleware,
  ctrlDocs.enviarDocumento
);
router.get('/juridico/associados/:cpfCnpj/documentos', auth, juridico, escopoFranquia, ctrlDocs.listarDocumentos);
router.get('/juridico/documentos/:id/download', auth, juridico, escopoFranquia, ctrlDocs.baixarDocumento);
// Visualização inline (sem download) — PDF/imagem stream direto,
// DOCX/XLSX convertidos pra HTML sanitizado na hora (ver
// previewDocumento.service.js). Mesma cadeia de middleware do download.
router.get('/juridico/documentos/:id/preview', auth, juridico, escopoFranquia, ctrlDocs.previewDocumento);
router.delete('/juridico/documentos/:id', auth, juridico, escopoFranquia, ctrlDocs.removerDocumento);

module.exports = router;
