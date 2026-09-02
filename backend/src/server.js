const env = require('./config/env');
const app = require('./app');
const { seedSuperAdminSeNecessario } = require('./services/usuarios.service');
const { migrarGoogleServiceAccountJsonSeNecessario } = require('./services/config.service');

// Multi-franquia, Fase 2, Passo 1 (ver docs/plano-multi-franquia.md) — semeia
// o primeiro Usuario (SUPER_ADMIN) antes de aceitar requisições. Não trava a
// subida do servidor se falhar (ex.: banco momentaneamente indisponível):
// o login continua funcionando via o fallback break-glass existente
// enquanto a tabela "usuarios" estiver vazia, então uma falha aqui só
// atrasa a semeadura pra próxima subida, não derruba a aplicação.
//
// Multi-franquia, Passo 4, Item 1 — migra GOOGLE_SERVICE_ACCOUNT_JSON do
// ambiente (se setada) pra dentro de "configuracoes" da franquia padrão, na
// mesma lógica: não trava a subida se falhar, e a migração em si é
// idempotente (não sobrescreve nada já salvo).
Promise.allSettled([seedSuperAdminSeNecessario(), migrarGoogleServiceAccountJsonSeNecessario()])
  .then(([resultadoSeed, resultadoMigracao]) => {
    if (resultadoSeed.status === 'rejected') {
      console.error('[usuarios] Falha ao semear SUPER_ADMIN (login segue via fallback):', resultadoSeed.reason);
    }
    if (resultadoMigracao.status === 'rejected') {
      console.error(
        '[config] Falha ao migrar GOOGLE_SERVICE_ACCOUNT_JSON do ambiente (login/app seguem normalmente):',
        resultadoMigracao.reason
      );
    }
  })
  .finally(() => {
    app.listen(env.port, () => {
      console.log(`Gestor de Inadimplência API rodando na porta ${env.port}`);
    });
  });
