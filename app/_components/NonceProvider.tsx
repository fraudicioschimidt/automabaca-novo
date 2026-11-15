"use client";

import { createContext, use } from "react";

const NonceContext = createContext<string | undefined>(undefined);

export function NonceProvider({ nonce, children }: {
  nonce?: string;
  children: React.ReactNode;
}) {
  return <NonceContext value={nonce}>{children}</NonceContext>;
}

export function useNonce(): string | undefined {
  return use(NonceContext);
}
