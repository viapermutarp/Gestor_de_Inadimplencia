import RequireAuth from "@/components/RequireAuth";
import RequireFranquiaSelecionada from "@/components/RequireFranquiaSelecionada";
import AppHeader from "@/components/AppHeader";

export default function DashboardLayout({ children }) {
  return (
    <RequireAuth>
      <div className="min-h-screen bg-background">
        <AppHeader />
        <div className="mx-auto max-w-7xl px-4 py-7 sm:px-6 lg:px-8">
          <RequireFranquiaSelecionada>{children}</RequireFranquiaSelecionada>
        </div>
      </div>
    </RequireAuth>
  );
}
