"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
import Spinner from "@/components/Spinner";

/** Protege qualquer página/layout: redireciona para /login se não houver sessão válida. */
export default function RequireAuth({ children }) {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace("/login");
      return;
    }
    setChecking(false);
  }, [router]);

  if (checking) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Spinner className="h-8 w-8" />
      </main>
    );
  }

  return children;
}
