-- CreateTable
CREATE TABLE "cadastros_enviados" (
    "id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'enviado',
    "resposta_n8n" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cadastros_enviados_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cadastros_enviados_criado_em_idx" ON "cadastros_enviados"("criado_em");

-- CreateIndex
CREATE INDEX "cadastros_enviados_status_idx" ON "cadastros_enviados"("status");
