const { Router } = require('express');
const auth = require('../middleware/auth');
const escopoFranquia = require('../middleware/escopoFranquia');
const exigirRecurso = require('../middleware/exigirRecurso');
const ctrl = require('../controllers/associados.controller');
const registroCtrl = require('../controllers/registroAssociados.controller');

const router = Router();

// Restrição de telas por franquia: todo este arquivo pertence à tela
// Dashboard (inclui o toggle "em_juridico" do próprio associado — não
// confundir com a aba nova "Jurídico"/Kanban, que é um recurso separado,
// ver juridico.routes.js).
const dashboard = exigirRecurso('dashboard');

// AJUSTE 19 — aba nova "Associados": recurso próprio, não reaproveita
// "dashboard". Rotas literais (registro/importar/importar/aplicar) IGUAIS
// aqui, ANTES de "/associados/:cpfCnpj" — Express casa a primeira rota que
// bater, e ":cpfCnpj" (parâmetro) casaria com "registro"/"importar" também
// se viesse antes.
const associados = exigirRecurso('associados');

router.get('/associados', auth, dashboard, escopoFranquia, ctrl.listar);
router.get('/associados/resumo', auth, dashboard, escopoFranquia, ctrl.resumo);
router.get('/associados/registro', auth, associados, escopoFranquia, registroCtrl.listar);
router.post(
  '/associados/importar',
  auth,
  associados,
  escopoFranquia,
  registroCtrl.uploadMiddleware,
  registroCtrl.importarPreview
);
router.post('/associados/importar/aplicar', auth, associados, escopoFranquia, registroCtrl.importarAplicar);
// AJUSTE 20 — "excluir cadastro" em massa: rota literal
// ("cadastro/excluir-lote"), mesmo cuidado de ordem do comentário acima —
// precisa vir antes de "/associados/:cpfCnpj" pro Express não tentar casar
// "cadastro" como valor de ":cpfCnpj" (aqui nem colidiria, por método/nº de
// segmentos, mas mantém o padrão de sempre pôr literais primeiro).
router.post('/associados/cadastro/excluir-lote', auth, associados, escopoFranquia, registroCtrl.excluirCadastroLote);
// Detalhe completo do associado — usado tanto pelo Dashboard quanto pela
// aba nova Associados (ver docblock de exigirRecurso.js): libera se o
// usuário tiver QUALQUER UMA das duas telas.
router.get('/associados/:cpfCnpj', auth, exigirRecurso(['dashboard', 'associados']), escopoFranquia, ctrl.detalhar);
router.patch('/associados/:cpfCnpj/negociacao', auth, dashboard, escopoFranquia, ctrl.atualizarNegociacao);
router.patch('/associados/:cpfCnpj/bloqueio', auth, dashboard, escopoFranquia, ctrl.atualizarBloqueio);
router.patch('/associados/:cpfCnpj/juridico', auth, dashboard, escopoFranquia, ctrl.atualizarJuridico);
router.get('/associados/:cpfCnpj/bloqueios/contador', auth, dashboard, escopoFranquia, ctrl.contadorBloqueios);
router.post('/associados/:cpfCnpj/bloqueios/resetar', auth, dashboard, escopoFranquia, ctrl.resetarBloqueios);
// AJUSTE 20 — "excluir cadastro" individual. Exige "associados" (não
// "dashboard") — é uma ação da aba nova, não do Dashboard.
router.delete('/associados/:cpfCnpj/cadastro', auth, associados, escopoFranquia, registroCtrl.excluirCadastro);

module.exports = router;
