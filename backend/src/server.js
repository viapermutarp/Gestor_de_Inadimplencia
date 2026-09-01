const env = require('./config/env');
const app = require('./app');
const { seedSuperAdminSeNecessario } = require('./services/usuarios.service');

// Multi-franquia, Fase 2, Passo 1 (ver docs/plano-multi-franquia.md) — semeia
// o primeiro Usuario (SUPER_ADMIN) antes de aceitar requisições. Não trava a
// subida do servidor se falhar (ex.: banco momentaneamente indisponível):
// o login continua funcionando via o fallback break-glass existente
// enquanto a tabela "usuarios" estiver vazia, então uma falha aqui só
// atrasa a semeadura pra próxima subida, não derruba a aplicação.
seedSuperAdminSeNecessario()
  .catch((err) => {
    console.error('[usuarios] Falha ao semear SUPER_ADMIN (login segue via fallback):', err);
  })
  .finally(() => {
    app.listen(env.port, () => {
      console.log(`Gestor de Inadimplência API rodando na porta ${env.port}`);
    });
  });
