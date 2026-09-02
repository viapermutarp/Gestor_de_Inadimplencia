/**
 * Restrição de telas por USUÁRIO (ver docs/plano-multi-franquia.md, seção
 * 8, item 8 — antes disso, era por franquia; "Usuario.recursosPermitidos"
 * substituiu "Franquia.recursosPermitidos", que ficou como campo legado
 * sem uso, ver schema.prisma). Fonte única das chaves válidas — usada
 * tanto pela validação em franquias.controller.js/usuarios.controller.js
 * (criar/editar) quanto pelo middleware/exigirRecurso.js (aplicado nas
 * rotas de cada tela).
 *
 * "Controle Geral" nunca entra nesta lista — não é um recurso restringível,
 * continua sendo SUPER_ADMIN only sem exceção (ver
 * middleware/exigirSuperAdmin.js), e não depende de usuário/franquia
 * nenhuma.
 */
const RECURSOS = ['dashboard', 'inadimplencia', 'cadastro', 'contratos', 'juridico', 'configuracoes'];

module.exports = { RECURSOS };
