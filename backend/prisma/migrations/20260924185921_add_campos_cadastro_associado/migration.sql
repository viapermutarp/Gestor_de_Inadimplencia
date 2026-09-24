-- AlterTable
ALTER TABLE "associados" ADD COLUMN     "bairro" TEXT,
ADD COLUMN     "celular" TEXT,
ADD COLUMN     "cep" TEXT,
ADD COLUMN     "cidade" TEXT,
ADD COLUMN     "complemento" TEXT,
ADD COLUMN     "contato_nome" TEXT,
ADD COLUMN     "data_entrada" DATE,
ADD COLUMN     "data_vencimento" DATE,
ADD COLUMN     "desconto_parcela" DECIMAL(12,2),
ADD COLUMN     "descricao_servico" TEXT,
ADD COLUMN     "email_cadastro" TEXT,
ADD COLUMN     "endereco" TEXT,
ADD COLUMN     "nome_fantasia" TEXT,
ADD COLUMN     "numero" TEXT,
ADD COLUMN     "numero_parcelas" INTEGER,
ADD COLUMN     "observacoes_cadastro" TEXT,
ADD COLUMN     "razao_social" TEXT,
ADD COLUMN     "tipo_pessoa" TEXT,
ADD COLUMN     "uf" TEXT,
ADD COLUMN     "valor_entrada" DECIMAL(12,2),
ADD COLUMN     "valor_parcela" DECIMAL(12,2),
ADD COLUMN     "valor_total" DECIMAL(12,2);

-- CreateIndex
CREATE INDEX "associados_email_cadastro_idx" ON "associados"("email_cadastro");
