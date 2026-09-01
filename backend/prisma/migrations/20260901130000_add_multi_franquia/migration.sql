-- Sistema multi-franquia (Fase 1: schema + migração de dados) — ver
-- docs/plano-multi-franquia.md. Cria "franquias"/"usuarios" e adiciona
-- franquia_id a todo model de negócio existente, seguindo o padrão
-- nullable -> backfill -> NOT NULL pra não quebrar dados já em produção.
-- Também migra "configuracoes" pra chave primária composta
-- (chave, franquia_id) — cada franquia passa a ter sua própria linha por
-- chave de configuração.
--
-- A migração de autenticação (login/refresh usando Usuario, semeadura do
-- SUPER_ADMIN a partir de ADMIN_USER/ADMIN_PASSWORD, troca de
-- refresh_tokens.usuario por usuario_id) é lógica de aplicação e fica pra
-- Fase 2 — não é feita nesta migração SQL. Até lá, a tabela "usuarios"
-- fica vazia (o que é esperado: é justamente a condição que aciona o
-- fallback break-glass via ADMIN_USER/ADMIN_PASSWORD).

CREATE TABLE "franquias" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "franquias_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "usuarios" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "senha_hash" TEXT NOT NULL,
    "papel" TEXT NOT NULL,
    "franquia_id" TEXT,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimo_login_em" TIMESTAMP(3),

    CONSTRAINT "usuarios_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "usuarios_email_key" ON "usuarios"("email");

-- Trava de 1 usuário por franquia no nível do banco (não só na tela de
-- Controle Geral). Postgres não considera NULL em índices únicos, então
-- múltiplos SUPER_ADMIN (franquia_id NULL) continuam permitidos — só uma
-- franquia não pode ter 2 usuários.
CREATE UNIQUE INDEX "usuarios_franquia_id_key" ON "usuarios"("franquia_id");

ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_franquia_id_fkey"
    FOREIGN KEY ("franquia_id") REFERENCES "franquias"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Semeia a franquia única de hoje (nome editável depois pela tela de
-- Controle Geral) e usa o id gerado pra fazer o backfill de todas as
-- tabelas de negócio abaixo, num único bloco transacional.
DO $$
DECLARE
    v_franquia_id TEXT := gen_random_uuid()::TEXT;
BEGIN
    INSERT INTO "franquias" ("id", "nome") VALUES (v_franquia_id, 'Via Permuta Ribeirão Preto');

    ALTER TABLE "associados" ADD COLUMN "franquia_id" TEXT;
    UPDATE "associados" SET "franquia_id" = v_franquia_id;
    ALTER TABLE "associados" ALTER COLUMN "franquia_id" SET NOT NULL;

    ALTER TABLE "cadastros_enviados" ADD COLUMN "franquia_id" TEXT;
    UPDATE "cadastros_enviados" SET "franquia_id" = v_franquia_id;
    ALTER TABLE "cadastros_enviados" ALTER COLUMN "franquia_id" SET NOT NULL;

    ALTER TABLE "modelos_contrato" ADD COLUMN "franquia_id" TEXT;
    UPDATE "modelos_contrato" SET "franquia_id" = v_franquia_id;
    ALTER TABLE "modelos_contrato" ALTER COLUMN "franquia_id" SET NOT NULL;

    ALTER TABLE "cobrancas_ignoradas" ADD COLUMN "franquia_id" TEXT;
    UPDATE "cobrancas_ignoradas" SET "franquia_id" = v_franquia_id;
    ALTER TABLE "cobrancas_ignoradas" ALTER COLUMN "franquia_id" SET NOT NULL;

    ALTER TABLE "sync_log" ADD COLUMN "franquia_id" TEXT;
    UPDATE "sync_log" SET "franquia_id" = v_franquia_id;
    ALTER TABLE "sync_log" ALTER COLUMN "franquia_id" SET NOT NULL;

    -- api_keys: NOT NULL, não fica global (correção em relação à primeira
    -- versão do plano — ver docs/plano-multi-franquia.md seção 1.3:
    -- sync/cadastros são autenticados por API key, e precisam saber a
    -- franquia pra gravar associados/cadastros com franquia_id obrigatório).
    ALTER TABLE "api_keys" ADD COLUMN "franquia_id" TEXT;
    UPDATE "api_keys" SET "franquia_id" = v_franquia_id;
    ALTER TABLE "api_keys" ALTER COLUMN "franquia_id" SET NOT NULL;

    ALTER TABLE "configuracoes" ADD COLUMN "franquia_id" TEXT;
    UPDATE "configuracoes" SET "franquia_id" = v_franquia_id;
    ALTER TABLE "configuracoes" ALTER COLUMN "franquia_id" SET NOT NULL;
END $$;

-- FKs + índices (fora do DO block — não dependem da variável local).
ALTER TABLE "associados" ADD CONSTRAINT "associados_franquia_id_fkey"
    FOREIGN KEY ("franquia_id") REFERENCES "franquias"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "associados_franquia_id_idx" ON "associados"("franquia_id");

ALTER TABLE "cadastros_enviados" ADD CONSTRAINT "cadastros_enviados_franquia_id_fkey"
    FOREIGN KEY ("franquia_id") REFERENCES "franquias"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "cadastros_enviados_franquia_id_idx" ON "cadastros_enviados"("franquia_id");

ALTER TABLE "modelos_contrato" ADD CONSTRAINT "modelos_contrato_franquia_id_fkey"
    FOREIGN KEY ("franquia_id") REFERENCES "franquias"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "modelos_contrato_franquia_id_idx" ON "modelos_contrato"("franquia_id");

ALTER TABLE "cobrancas_ignoradas" ADD CONSTRAINT "cobrancas_ignoradas_franquia_id_fkey"
    FOREIGN KEY ("franquia_id") REFERENCES "franquias"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "cobrancas_ignoradas_franquia_id_idx" ON "cobrancas_ignoradas"("franquia_id");

ALTER TABLE "sync_log" ADD CONSTRAINT "sync_log_franquia_id_fkey"
    FOREIGN KEY ("franquia_id") REFERENCES "franquias"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "sync_log_franquia_id_idx" ON "sync_log"("franquia_id");

ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_franquia_id_fkey"
    FOREIGN KEY ("franquia_id") REFERENCES "franquias"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "api_keys_franquia_id_idx" ON "api_keys"("franquia_id");

-- configuracoes: troca a PK simples (chave) pela composta (chave, franquia_id).
ALTER TABLE "configuracoes" DROP CONSTRAINT "configuracoes_pkey";
ALTER TABLE "configuracoes" ADD CONSTRAINT "configuracoes_pkey" PRIMARY KEY ("chave", "franquia_id");
ALTER TABLE "configuracoes" ADD CONSTRAINT "configuracoes_franquia_id_fkey"
    FOREIGN KEY ("franquia_id") REFERENCES "franquias"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "configuracoes_franquia_id_idx" ON "configuracoes"("franquia_id");
