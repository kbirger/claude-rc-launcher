import { getConnInfo } from "@hono/bun";
import type { Context } from "hono";
import { isIPv4, isIPv6 } from "node:net";
import type { ProxyJwtUserAuth } from "../config/parse";
import type { JwtVerifier } from "./jwt";
import { isAllowed, userFromClaims } from "./user";
import type { UserAuthStrategy } from "./user";

interface Ip {
  version: 4 | 6;
  value: bigint;
}

function parseIp(raw: string): Ip | null {
  if (isIPv4(raw))
    return { version: 4, value: raw.split(".").reduce((total, octet) => (total << 8n) | BigInt(octet), 0n) };
  if (!isIPv6(raw)) return null;
  let address = raw;
  const lastColon = address.lastIndexOf(":");
  const tail = address.slice(lastColon + 1);

  if (tail.includes(".")) {
    if (!isIPv4(tail)) return null;
    const [first, second, third, fourth] = tail.split(".").map(Number) as [number, number, number, number];
    address = `${address.slice(0, lastColon + 1)}${((first << 8) | second).toString(16)}:${((third << 8) | fourth).toString(16)}`;
  }

  const [head, rest] = address.split("::") as [string, string | undefined];
  const headGroups = head ? head.split(":") : [];
  const tailGroups = rest === undefined ? [] : rest ? rest.split(":") : [];
  const groups =
    rest === undefined
      ? headGroups
      : [...headGroups, ...Array<string>(8 - headGroups.length - tailGroups.length).fill("0"), ...tailGroups];
  if (groups.length !== 8) return null;
  const bits = groups.reduce((group, hex) => (group << 16n) | BigInt(`0x${hex}`), 0n);
  // ::ffff:a.b.c.d is IPv4 in IPv6 clothing
  if (bits >> 32n === 0xffffn) return { version: 4, value: bits & 0xffffffffn };
  return { version: 6, value: bits };
}

type Net = Ip & { bits: number };

function parseNet(entry: string): Net | null {
  const [addr, len, ...extra] = entry.split("/") as [string, string | undefined, ...string[]];
  if (extra.length) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const max = ip.version === 4 ? 32 : 128;
  if (len === undefined) return { ...ip, bits: max };
  if (!/^\d{1,3}$/.test(len)) return null;
  const bits = Number(len);
  // A prefix on a mapped IPv4-in-IPv6 address is ambiguous; reject rather than guess.
  if (bits > max || (isIPv6(addr) && ip.version === 4)) return null;
  return { ...ip, bits };
}

/** True if `entry` is an IPv4/IPv6 address or CIDR we can match against. */
export const validPeer = (entry: string) => parseNet(entry) !== null;

/** Exact address or CIDR match; `::ffff:a.b.c.d` is treated as IPv4. Malformed input never matches. */
export function cidrContains(list: string[], addr: string): boolean {
  const ip = parseIp(addr);
  if (!ip) return false;
  const max = ip.version === 4 ? 32n : 128n;
  return list.some((item) => {
    const net = parseNet(item);
    if (net?.version !== ip.version) return false;
    const shift = max - BigInt(net.bits);
    return net.value >> shift === ip.value >> shift;
  });
}

export type PeerResolver = (context: Context) => string | undefined;

const defaultPeer: PeerResolver = (context) => {
  try {
    return getConnInfo(context).remote.address;
  } catch {
    return undefined;
  }
};

export function proxyJwtUserAuth(options: {
  settings: ProxyJwtUserAuth;
  verify: JwtVerifier;
  peer?: PeerResolver;
}): UserAuthStrategy {
  const { settings, verify } = options;
  const peer = options.peer ?? defaultPeer;
  return {
    ...(settings.logoutUrl ? { logoutUrl: settings.logoutUrl } : {}),
    middleware: async (context, next) => {
      if (settings.trustedPeers.length > 0) {
        const peerAddress = peer(context);
        if (peerAddress === undefined || !cidrContains(settings.trustedPeers, peerAddress))
          return context.json({ error: "forbidden" }, 403);
      }

      const token = context.req.header(settings.header);
      if (!token) return context.json({ error: "unauthenticated" }, 401);
      let claims;

      try {
        claims = await verify(token);
      } catch {
        return context.json({ error: "unauthenticated" }, 401);
      }

      const user = userFromClaims(claims, settings.roles);
      if (!user) return context.json({ error: "unauthenticated" }, 401);
      if (!isAllowed(user, settings.allowedUsers)) return context.json({ error: "user is not allowed" }, 403);
      if (user.role === "none") return context.json({ error: "access refused" }, 403);
      context.set("user" as never, user as never);
      await next();
    },
  };
}
