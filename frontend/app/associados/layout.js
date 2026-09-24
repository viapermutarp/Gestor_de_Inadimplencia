import RequireAuth from "@/components/RequireAuth";
import RequireFranquiaSelecionada from "@/components/RequireFranquiaSelecionada";
import RequireRecurso from "@/components/RequireRecurso";
import AppHeader from "@/components/AppHeader";

// AJUSTE 19 — aba "Associados": recurso próprio ("associados"), não
// reaproveita "dashboard" (ver docblock de exigirRecurso.js no backend e o
// mesmo padrão de layout usado em app/contratos, app/juridico etc.).
export default function AssociadosLayout({ children }) {
  return (
    <RequireAuth>
      <div className="min-h-screen bg-background">
        <AppHeader />
        <div className="mx-auto max-w-7xl px-4 py-7 sm:px-6 lg:px-8">
          <RequireRecurso chave="associados">
            <RequireFranquiaSelecionada>{children}</RequireFranquiaSelecionada>
          </RequireRecurso>
        </div>
      </div>
    </RequireAuth>
  );
}
