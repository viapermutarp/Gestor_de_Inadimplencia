"use client";

import { useCallback, useEffect, useState } from "react";
import { getAssociadosRegistro, ApiError } from "@/lib/api";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import PaginacaoControles from "@/components/PaginacaoControles";
import AssociadoCadastroDetalheModal from "@/components/AssociadoCadastroDetalheModal";
import ImportarAssociadosModal from "@/components/ImportarAssociadosModal";
import { IconSearch, IconUpload } from "@/components/icons";

const LIMITE_POR_PAGINA = 100;
const PAGINACAO_PADRAO = {
  pagina_atual: 1,
  total_paginas: 1,
  total_registros: 0,
  por_pagina: LIMITE_POR_PAGINA,
};

/**
 * AJUSTE 19 — aba "Associados": lista simples da carteira cadastral
 * (Nome, CPF/CNPJ, Cidade, Telefone), com busca por nome/CPF-CNPJ/e-mail —
 * mesmo estilo visual do resto do sistema (confirmado com o usuário: sem
 * componente "estilo Bling" pra reaproveitar). Clicar numa linha abre o
 * detalhe completo (AssociadoCadastroDetalheModal). Botão "Importar CSV"
 * abre o fluxo de importação em lote (ImportarAssociadosModal).
 */
export default function AssociadosPage() {
  const [associados, setAssociados] = useState([]);
  const [paginacao, setPaginacao] = useState(PAGINACAO_PADRAO);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [buscaInput, setBuscaInput] = useState("");
  const [busca, setBusca] = useState("");

  const [selectedCpfCnpj, setSelectedCpfCnpj] = useState(null);
  const [importando, setImportando] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setBusca(buscaInput.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [buscaInput]);

  const carregarPagina = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = { page, limit: LIMITE_POR_PAGINA };
      if (busca) params.busca = busca;
      const data = await getAssociadosRegistro(params);
      setAssociados(Array.isArray(data?.dados) ? data.dados : []);
      setPaginacao(data?.paginacao ?? PAGINACAO_PADRAO);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Erro ao carregar associados.");
    } finally {
      setLoading(false);
    }
  }, [busca, page]);

  useEffect(() => {
    carregarPagina();
  }, [carregarPagina]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-xl font-bold text-foreground">Associados</h1>
          <p className="text-sm text-muted-foreground">Carteira cadastral completa — dados vindos do Cadastro.</p>
        </div>
        <button
          type="button"
          onClick={() => setImportando(true)}
          className="flex shrink-0 items-center gap-2 rounded-xl border border-border-soft bg-surface px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover"
        >
          <IconUpload className="h-4 w-4" />
          Importar CSV
        </button>
      </div>

      <div className="relative w-full sm:max-w-xs">
        <IconSearch className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <input
          type="text"
          value={buscaInput}
          onChange={(e) => setBuscaInput(e.target.value)}
          placeholder="Buscar por nome, CPF/CNPJ ou e-mail"
          className="w-full rounded-xl border border-border-soft bg-surface px-10 py-2.5 text-sm text-foreground placeholder:text-muted/60 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>

      {error && <ErrorBanner message={error} onRetry={carregarPagina} />}

      <div className="overflow-hidden rounded-2xl border border-border-soft bg-surface shadow-lg shadow-black/20">
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-border-soft text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-5 py-3.5 font-semibold">Nome</th>
                <th className="px-5 py-3.5 font-semibold">CPF/CNPJ</th>
                <th className="px-5 py-3.5 font-semibold">Cidade</th>
                <th className="px-5 py-3.5 font-semibold">Telefone</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={4} className="px-5 py-12 text-center">
                    <Spinner className="mx-auto h-6 w-6" />
                  </td>
                </tr>
              ) : associados.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-5 py-12 text-center text-muted-foreground">
                    Nenhum associado encontrado.
                  </td>
                </tr>
              ) : (
                associados.map((associado) => (
                  <tr
                    key={associado.cpf_cnpj}
                    onClick={() => setSelectedCpfCnpj(associado.cpf_cnpj)}
                    className="cursor-pointer border-b border-border-soft/60 last:border-0 transition-colors hover:bg-surface-hover"
                  >
                    <td className="px-5 py-3.5 font-medium text-foreground">
                      {associado.razao_social || associado.nome_fantasia || associado.nome || "-"}
                    </td>
                    <td className="px-5 py-3.5 font-mono text-muted-foreground">{associado.cpf_cnpj}</td>
                    <td className="px-5 py-3.5 text-muted-foreground">{associado.cidade || "-"}</td>
                    <td className="px-5 py-3.5 font-mono text-muted-foreground">
                      {associado.celular || associado.telefone || "-"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <PaginacaoControles paginacao={paginacao} onChangePage={setPage} disabled={loading} />
      </div>

      {selectedCpfCnpj && (
        <AssociadoCadastroDetalheModal cpfCnpj={selectedCpfCnpj} onClose={() => setSelectedCpfCnpj(null)} />
      )}

      {importando && (
        <ImportarAssociadosModal onClose={() => setImportando(false)} onImportado={carregarPagina} />
      )}
    </div>
  );
}
