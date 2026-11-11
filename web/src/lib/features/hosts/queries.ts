import { commonQuery } from "../../shared/query";
import { listHosts } from "./api";

export const HOSTS_KEY = ["hosts"] as const;

export const hostsQuery = () => ({ queryKey: HOSTS_KEY, queryFn: listHosts, ...commonQuery });
