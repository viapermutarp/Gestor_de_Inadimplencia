const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const env = require('../config/env');

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

exports.login = (req, res) => {
  const { usuario, senha } = req.body || {};

  if (!usuario || !senha) {
    return res.status(400).json({ error: 'Informe usuario e senha.' });
  }

  const usuarioOk = safeEqual(usuario, env.adminUser);
  const senhaOk = safeEqual(senha, env.adminPassword);

  if (!usuarioOk || !senhaOk) {
    return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
  }

  const token = jwt.sign({ sub: usuario }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });

  res.json({ token, tipo: 'Bearer', expira_em: env.jwtExpiresIn });
};
