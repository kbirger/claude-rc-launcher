import { QueryClient } from "@tanstack/svelte-query";

export const STALE_MS = 300_000;

export const commonQuery = { staleTime: STALE_MS, refetchOnWindowFocus: true } as const;

export const createQueryClient = (): QueryClient => new QueryClient();
