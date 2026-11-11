import { getMe } from "./api";

export const meQuery = () => ({ queryKey: ["me"] as const, queryFn: getMe, staleTime: Infinity, retry: false as const });
