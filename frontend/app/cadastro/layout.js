import RequireAuth from "@/components/RequireAuth";
import AppHeader from "@/components/AppHeader";

export default function CadastroLayout({ children }) {
  return (
    <RequireAuth>
      <div className="min-h-screen bg-background">
        <AppHeader />
        <div className="mx-auto max-w-3xl px-4 py-7 sm:px-6 lg:px-8">{children}</div>
      </div>
    </RequireAuth>
  );
}
