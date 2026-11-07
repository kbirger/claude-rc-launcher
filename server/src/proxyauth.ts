import { isIPv4, isIPv6 } from "node:net";
import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import type { ProxyJwtUserAuth } from "./config";
import type { JwtVerifier } from "./jwt";
import { isAllowed, userFromClaims, type UserAuthStrategy } from "./userauth";

type Ip = { v: 4 | 6; n: bigint };

function parseIp(raw: string): Ip | null {
  if (isIPv4(raw)) return { v: 4, n: raw.split(".").reduce((a, o) => (a << 8n) | BigInt(o), 0n) };
  if (!isIPv6(raw)) return null;
  let s = raw;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!isIPv4(tail)) return null;
    const [a, b, c, d] = tail.split(".").map(Number) as [number, number, number, number];
    s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = s.split("::") as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const r = rest === undefined ? [] : rest ? rest.split(":") : [];
  const groups = rest === undefined ? h : [...h, ...Array<string>(8 - h.length - r.length).fill("0"), ...r];
  if (groups.length !== 8) return null;
  const n = groups.reduce((a, g) => (a << 16n) | BigInt(`0x${g}`), 0n);
  // ::ffff:a.b.c.d is IPv4 in IPv6 clothing
  if (n >> 32n === 0xffffn) return { v: 4, n: n & 0xffffffffn };
  return { v: 6, n };
}

type Net = Ip & { bits: number };

function parseNet(entry: string): Net | null {
  const [addr, len, ...extra] = entry.split("/") as [string, string | undefined, ...string[]];
  if (extra.length) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const max = ip.v === 4 ? 32 : 128;
  if (len === undefined) return { ...ip, bits: max };
  if (!/^\d{1,3}$/.test(len)) return null;
  const bits = Number(len);
  // A prefix on a mapped IPv4-in-IPv6 address is ambiguous; reject rather than guess.
  if (bits > max || (isIPv6(addr) && ip.v === 4)) return null;
  return { ...ip, bits };
}

/** True if `entry` is an IPv4/IPv6 address or CIDR we can match against. */
export const validPeer = (entry: string) => parseNet(entry) !== null;

/** Exact address or CIDR match; `::ffff:a.b.c.d` is treated as IPv4. Malformed input never matches. */
export function cidrContains(list: string[], addr: string): boolean {
  const ip = parseIp(addr);
  if (!ip) return false;
  const max = ip.v === 4 ? 32n : 128n;
  return list.some((e) => {
    const net = parseNet(e);
    if (!net || net.v !== ip.v) return false;
    const shift = max - BigInt(net.bits);
    return net.n >> shift === ip.n >> shift;
  });
}

export type PeerResolver = (c: Context) => string | undefined;

const defaultPeer: PeerResolver = (c) => {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
};

export function proxyJwtUserAuth(o: { settings: ProxyJwtUserAuth; verify: JwtVerifier; peer?: PeerResolver }): UserAuthStrategy {
  const { settings, verify } = o;
  const peer = o.peer ?? defaultPeer;
  return {
    ...(settings.logoutUrl ? { logoutUrl: settings.logoutUrl } : {}),
    middleware: async (c, next) => {
      if (settings.trustedPeers.length > 0) {
        const p = peer(c);
        if (p === undefined || !cidrContains(settings.trustedPeers, p)) return c.json({ error: "forbidden" }, 403);
      }
      const token = c.req.header(settings.header);
      if (!token) return c.json({ error: "unauthenticated" }, 401);
      let claims;
      try {
        claims = await verify(token);
      } catch {
        return c.json({ error: "unauthenticated" }, 401);
      }
      const user = userFromClaims(claims);
      if (!user) return c.json({ error: "unauthenticated" }, 401);
      if (!isAllowed(user, settings.allowedUsers)) return c.json({ error: "user is not allowed" }, 403);
      c.set("user" as never, user as never);
      await next();
    },
  };
}
