import RequireAuth from "@/components/RequireAuth";
import RequireSuperAdmin from "@/components/RequireSuperAdmin";
import AppHeader from "@/components/AppHeader";

// Multi-franquia — Etapa 5. Sem RequireFranquiaSelecionada de propósito:
// "Controle Geral" é a única tela que NÃO depende de seleção de franquia —
// é cross-franquia por natureza (ver escopo, item 4).
export default function ControleGeralLayout({ children }) {
  return (
    <RequireAuth>
      <RequireSuperAdmin>
        <div className="min-h-screen bg-background">
          <AppHeader />
          <div className="mx-auto max-w-4xl px-4 py-7 sm:px-6 lg:px-8">{children}</div>
        </div>
      </RequireSuperAdmin>
    </RequireAuth>
  );
}
