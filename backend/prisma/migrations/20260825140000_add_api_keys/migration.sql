-- Múltiplas API keys (substitui a chave única de "configuracoes").
-- A chave única antiga é importada automaticamente na aplicação (ver
-- migrarChaveLegadaSeNecessario em src/services/apiKeys.service.js) — não
-- há migração de dados aqui em SQL.
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "tamanho" INTEGER NOT NULL,
    "ultimos_caracteres" TEXT NOT NULL,
    "criada_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimo_uso_em" TIMESTAMP(3),
    "revogada_em" TIMESTAMP(3),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_keys_hash_key" ON "api_keys"("hash");

CREATE INDEX "api_keys_revogada_em_idx" ON "api_keys"("revogada_em");
