-- CreateTable
CREATE TABLE "cobrancas_ignoradas" (
    "id" TEXT NOT NULL,
    "asaas_payment_id" TEXT NOT NULL,
    "motivo" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cobrancas_ignoradas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cobrancas_ignoradas_asaas_payment_id_key" ON "cobrancas_ignoradas"("asaas_payment_id");
