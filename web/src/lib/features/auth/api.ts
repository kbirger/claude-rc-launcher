import { request } from "../../shared/http";

import type { Role } from "./can";

export type Me = { sub: string; name: string; email?: string; username?: string; role?: Role; logoutUrl?: string };

export const getMe = () => request<Me>("GET", "/api/me");
