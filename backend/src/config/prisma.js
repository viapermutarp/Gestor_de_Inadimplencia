const { PrismaClient } = require('@prisma/client');

// Evita múltiplas instâncias do PrismaClient em hot-reload durante o desenvolvimento.
const prisma = global.__prisma || new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma;
}

module.exports = prisma;
