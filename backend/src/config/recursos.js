/**
 * Restrição de telas por franquia (ver docs/plano-multi-franquia.md).
 * Fonte única das chaves válidas de "Franquia.recursosPermitidos" — usada
 * tanto pela validação em franquias.controller.js (criar/editar) quanto
 * pelo middleware/exigirRecurso.js (aplicado nas rotas de cada tela).
 *
 * "Controle Geral" nunca entra nesta lista — não é um recurso restringível,
 * continua sendo SUPER_ADMIN only sem exceção (ver
 * middleware/exigirSuperAdmin.js), e não depende de franquia nenhuma.
 */
const RECURSOS = ['dashboard', 'inadimplencia', 'cadastro', 'contratos', 'juridico', 'configuracoes'];

module.exports = { RECURSOS };
