// Restrição de telas por franquia (ver escopo do pedido, item 2) — mesmas
// chaves de RECURSOS no backend (src/config/recursos.js), com o rótulo
// exibido nos checkboxes de Controle Geral e nos links do menu (AppHeader).
// "Controle Geral" nunca entra aqui — não é um recurso restringível.
export const RECURSOS = [
  { chave: "dashboard", label: "Dashboard" },
  { chave: "inadimplencia", label: "Taxa de Inadimplência %" },
  { chave: "cadastro", label: "Cadastro" },
  { chave: "contratos", label: "Contratos" },
  { chave: "juridico", label: "Jurídico" },
  { chave: "configuracoes", label: "Configurações" },
];

export const CHAVES_RECURSOS = RECURSOS.map((r) => r.chave);
