"use server";

import { z } from "zod";
import { actor } from "./_auth";
import { searchPanel, type PanelSearchResult } from "@/src/services/painel/search";

const querySchema = z.string().trim().min(2).max(80);

export async function searchPanelAction(raw: unknown): Promise<PanelSearchResult[]> {
  await actor();
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) return [];
  return searchPanel(parsed.data);
}

