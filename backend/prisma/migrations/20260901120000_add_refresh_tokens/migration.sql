-- Refresh tokens da sessão do painel (access token curto + refresh token
-- revogável) — ver "Autenticação: access token curto + refresh token" no
-- README do backend para o diagnóstico do bug que motivou esta mudança.
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "usuario" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expira_em" TIMESTAMP(3) NOT NULL,
    "revogado_em" TIMESTAMP(3),
    "ultimo_uso_em" TIMESTAMP(3),

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

CREATE INDEX "refresh_tokens_usuario_idx" ON "refresh_tokens"("usuario");

CREATE INDEX "refresh_tokens_revogado_em_idx" ON "refresh_tokens"("revogado_em");
