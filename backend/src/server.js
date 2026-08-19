const env = require('./config/env');
const app = require('./app');

app.listen(env.port, () => {
  console.log(`Gestor de Inadimplência API rodando na porta ${env.port}`);
});
