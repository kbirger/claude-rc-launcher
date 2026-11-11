import { request } from "../../shared/http";

export type Me = { sub: string; name: string; email?: string; username?: string; logoutUrl?: string };

export const getMe = () => request<Me>("GET", "/api/me");
