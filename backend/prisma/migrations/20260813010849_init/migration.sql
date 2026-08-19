-- CreateTable
CREATE TABLE "associados" (
    "id" TEXT NOT NULL,
    "cpf_cnpj" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "telefone" TEXT NOT NULL,
    "email" TEXT,
    "em_negociacao" BOOLEAN NOT NULL DEFAULT false,
    "observacao" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "associados_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cobrancas" (
    "id" TEXT NOT NULL,
    "associado_id" TEXT NOT NULL,
    "valor" DECIMAL(12,2) NOT NULL,
    "vencimento" DATE NOT NULL,
    "dias_diferenca" INTEGER NOT NULL,
    "link_pagamento" TEXT,
    "descricao" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sincronizado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cobrancas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "historico_negociacao" (
    "id" TEXT NOT NULL,
    "associado_id" TEXT NOT NULL,
    "status_anterior" BOOLEAN NOT NULL,
    "status_novo" BOOLEAN NOT NULL,
    "alterado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historico_negociacao_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "associados_cpf_cnpj_key" ON "associados"("cpf_cnpj");

-- CreateIndex
CREATE INDEX "associados_cpf_cnpj_idx" ON "associados"("cpf_cnpj");

-- CreateIndex
CREATE INDEX "cobrancas_associado_id_idx" ON "cobrancas"("associado_id");

-- CreateIndex
CREATE INDEX "cobrancas_status_idx" ON "cobrancas"("status");

-- CreateIndex
CREATE INDEX "historico_negociacao_associado_id_idx" ON "historico_negociacao"("associado_id");

-- AddForeignKey
ALTER TABLE "cobrancas" ADD CONSTRAINT "cobrancas_associado_id_fkey" FOREIGN KEY ("associado_id") REFERENCES "associados"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historico_negociacao" ADD CONSTRAINT "historico_negociacao_associado_id_fkey" FOREIGN KEY ("associado_id") REFERENCES "associados"("id") ON DELETE CASCADE ON UPDATE CASCADE;

