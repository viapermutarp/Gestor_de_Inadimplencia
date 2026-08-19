#!/bin/sh
set -e

echo "Aplicando migrações do Prisma..."

RETRIES=10
until npx prisma migrate deploy; do
  RETRIES=$((RETRIES - 1))
  if [ "$RETRIES" -le 0 ]; then
    echo "Não foi possível aplicar as migrações após várias tentativas. Abortando."
    exit 1
  fi
  echo "Banco de dados ainda não disponível. Tentando novamente em 3s... ($RETRIES tentativas restantes)"
  sleep 3
done

echo "Migrações aplicadas com sucesso."

exec "$@"
