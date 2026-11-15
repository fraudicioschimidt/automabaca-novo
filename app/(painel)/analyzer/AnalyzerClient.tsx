"use client";

import { AnalyzerScreen } from "@/app/_design/screens/AnalyzerScreen";
import { DesignScreen } from "@/app/_design/DesignScreen";
import type { AnalyzerScreenProps } from "@/app/_design/screen-types";
import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import type { AnalyzerQuery } from "@/src/domain/analyzer-query";

type AnalyzerData = NonNullable<AnalyzerScreenProps["data"]>;

/**
 * O Analyzer de uma banca ou da carteira. `path` é a rota que recebe o recorte
 * na URL (`/tipsters/<slug>/analyzer` ou `/analyzer`).
 */
export function AnalyzerClient({
  path,
  slug,
  bkId,
  data,
  initialMode,
}: {
  path: string;
  slug: string | null;
  bkId: string | null;
  data: AnalyzerData;
  initialMode: "light" | "dark";
}) {
  const router = useRouter();
  const search = useSearchParams();
  const [queryPending, startTransition] = useTransition();
  const onQueryChange = (change: Partial<AnalyzerQuery>) => {
    const params = new URLSearchParams(search.toString());
    for (const [key, value] of Object.entries(change)) {
      if (value === "") params.delete(key);
      else params.set(key, String(value));
    }
    if (change.periodo !== undefined) params.delete("pagina");
    startTransition(() => router.push(`${path}?${params}`, { scroll: false }));
  };
  return (
    <DesignScreen initialMode={initialMode}>
      <AnalyzerScreen
        slug={slug}
        bkId={bkId}
        data={data}
        onQueryChange={data?.query ? onQueryChange : null}
        queryPending={queryPending}
      />
    </DesignScreen>
  );
}
