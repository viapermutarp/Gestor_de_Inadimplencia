FROM node:20-alpine

WORKDIR /app

# node:20-alpine não vem com openssl por padrão, e o Prisma precisa dele
# para detectar a versão do libssl/openssl e baixar o query engine correto
# para Alpine (linux-musl-openssl-3.0.x). Instala antes de tudo que usa
# Prisma, para não faltar essa lib nem no build nem no runtime da imagem.
RUN apk add --no-cache openssl

# Instala dependências primeiro (melhora cache de build)
COPY package*.json ./
RUN npm install

# Gera o Prisma Client a partir do schema
COPY prisma ./prisma
RUN npx prisma generate

# Copia o restante do código
COPY . .

RUN chmod +x docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
