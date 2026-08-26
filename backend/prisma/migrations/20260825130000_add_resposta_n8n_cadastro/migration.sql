-- Adiciona os campos capturados da resposta do webhook do n8n em
-- cadastros_enviados (ver POST /api/cadastros e enviarParaN8n em
-- cadastros.controller.js). Antes, o backend só sabia se a chamada HTTP ao
-- n8n tinha ido bem, sem repassar o link de pagamento nem os IDs gerados
-- (Asaas/Bling) de volta pro formulário de Cadastro.
ALTER TABLE "cadastros_enviados" ADD COLUMN "link_pagamento" TEXT;
ALTER TABLE "cadastros_enviados" ADD COLUMN "cliente_asaas_id" TEXT;
ALTER TABLE "cadastros_enviados" ADD COLUMN "pedido_bling_id" TEXT;
