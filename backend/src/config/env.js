const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

require('dotenv').config();

const ENV_PATH = path.resolve(__dirname, '..', '..', '.env');

function generateSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Garante que a variável de ambiente exista. Se não existir, gera um valor
 * forte, aplica em process.env para uso imediato e tenta persistir no
 * arquivo .env (útil em execução local / docker-compose com volume montado).
 */
function ensureEnvVar(name, generator) {
  if (process.env[name] && process.env[name].trim() !== '') {
    return process.env[name];
  }

  const value = generator();
  process.env[name] = value;

  try {
    const line = `${name}=${value}`;
    if (fs.existsSync(ENV_PATH)) {
      const content = fs.readFileSync(ENV_PATH, 'utf8');
      if (!new RegExp(`^${name}=.*$`, 'm').test(content)) {
        const separator = content.endsWith('\n') || content.length === 0 ? '' : '\n';
        fs.appendFileSync(ENV_PATH, `${separator}${line}\n`);
      } else {
        const updated = content.replace(new RegExp(`^${name}=.*$`, 'm'), line);
        fs.writeFileSync(ENV_PATH, updated);
      }
    } else {
      fs.writeFileSync(ENV_PATH, `${line}\n`);
    }
    console.log(`[env] ${name} não estava definido. Um novo valor foi gerado e salvo em .env.`);
  } catch (err) {
    console.warn(
      `[env] ${name} não estava definido. Um valor foi gerado apenas em memória ` +
        `(não foi possível gravar em .env: ${err.message}).`
    );
  }

  return value;
}

function loadEnv() {
  ensureEnvVar('API_KEY', () => generateSecret(32));
  ensureEnvVar('JWT_SECRET', () => generateSecret(48));

  const required = ['DATABASE_URL', 'ADMIN_USER', 'ADMIN_PASSWORD'];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length) {
    console.error(`[env] Variáveis obrigatórias ausentes: ${missing.join(', ')}`);
    process.exit(1);
  }

  return {
    port: Number(process.env.PORT) || 3000,
    databaseUrl: process.env.DATABASE_URL,
    apiKey: process.env.API_KEY,
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
    adminUser: process.env.ADMIN_USER,
    adminPassword: process.env.ADMIN_PASSWORD,
  };
}

module.exports = loadEnv();
