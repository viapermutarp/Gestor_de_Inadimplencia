-- CreateTable
CREATE TABLE "pagamentos_asaas" (
    "id" TEXT NOT NULL,
    "franquia_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "cpf_cnpj" TEXT,
    "nome" TEXT,
    "value" DECIMAL(12,2) NOT NULL,
    "due_date" TEXT NOT NULL,
    "payment_date" TEXT,
    "status" TEXT NOT NULL,
    "description" TEXT,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pagamentos_asaas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pagamentos_asaas_franquia_id_due_date_idx" ON "pagamentos_asaas"("franquia_id", "due_date");

-- CreateIndex
CREATE INDEX "pagamentos_asaas_franquia_id_status_idx" ON "pagamentos_asaas"("franquia_id", "status");

-- AddForeignKey
ALTER TABLE "pagamentos_asaas" ADD CONSTRAINT "pagamentos_asaas_franquia_id_fkey" FOREIGN KEY ("franquia_id") REFERENCES "franquias"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
