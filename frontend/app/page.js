"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isAuthenticated, rotaInicial } from "@/lib/auth";
import Spinner from "@/components/Spinner";

export default function RootPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace(isAuthenticated() ? rotaInicial() : "/login");
  }, [router]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background">
      <Spinner className="h-8 w-8" />
    </main>
  );
}
