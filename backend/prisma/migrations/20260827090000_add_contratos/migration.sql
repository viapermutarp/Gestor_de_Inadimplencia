-- Modelos de contrato (geração automática de .docx a partir de um Cadastro)
CREATE TABLE "modelos_contrato" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "conteudo" TEXT NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "modelos_contrato_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "modelos_contrato_ativo_idx" ON "modelos_contrato"("ativo");

-- Campos novos em cadastros_enviados: pasta/contratos selecionados e o
-- resultado da geração (preenchido depois, de forma assíncrona).
ALTER TABLE "cadastros_enviados"
  ADD COLUMN "nome_pasta" TEXT,
  ADD COLUMN "modelos_contrato_ids" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN "pasta_drive_id" TEXT,
  ADD COLUMN "arquivos_gerados" JSONB;
