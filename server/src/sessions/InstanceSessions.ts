import type { LiveInfo } from "./live";
import { chooseName, nameInfoOf, tidy } from "./names";
import type { NameInfo } from "./names";
import { scan } from "./scan";
import type { Found } from "./scan";
import { Session } from "./Session";
import type { SessionCatalog, SessionSummary } from "./SessionCatalog";
import { SESSION_ID } from "./transcript";

/** At most this many transcripts are read for names at once, so that a big folder stays under the open-file limit. */
const NAME_READS = 8;

/** The `live` field of a session summary, copied field by field: nothing else from the running-session file reaches the answer. */
export function liveOf(info: LiveInfo): { status?: string; remoteControl: boolean } {
  const live: { status?: string; remoteControl: boolean } = { remoteControl: info.remoteControl };
  if (info.status !== undefined) live.status = info.status;
  return live;
}

/** `fn` over `items` with at most `limit` running at once. Results keep the order of `items`. */
export async function mapLimit<Value, Result>(
  items: readonly Value[],
  limit: number,
  fn: (value: Value) => Promise<Result>,
): Promise<Result[]> {
  const out = new Array<Result>(items.length);
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** A `/clear` starts its transcript a moment after the old one gets its last write (0.11 to 0.23 s in the real data). */
const CLEAR_BEFORE_MS = 500;
const CLEAR_AFTER_MS = 2500;

/**
 * Pairs (older id, newer id) for transcripts that start with `/clear`. The older transcript is the only other transcript
 * of the folder whose last write is within a moment of the `/clear` command. A second candidate, or an older transcript
 * that two `/clear` transcripts want, gives no pair: a wrong join is worse than a missing one.
 */
export function matchByTime(found: readonly Found[]): [string, string][] {
  const wanted = new Map<string, string[]>();

  for (const session of found) {
    const { clearedAt } = session;
    if (clearedAt === undefined) continue;
    const founds = found.filter(
      (item) =>
        item.id !== session.id &&
        item.mtimeMs >= clearedAt - CLEAR_BEFORE_MS &&
        item.mtimeMs <= clearedAt + CLEAR_AFTER_MS,
    );
    if (founds.length === 1) wanted.set(founds[0].id, [...(wanted.get(founds[0].id) ?? []), session.id]);
  }

  return [...wanted].flatMap(([pred, succ]) => (succ.length === 1 ? [[pred, succ[0]] as [string, string]] : []));
}

export class InstanceSessions {
  constructor(
    readonly catalog: SessionCatalog,
    readonly path: string,
    readonly home: string,
  ) {}

  /** List the sessions of the folder, newest first. All are listed. Only a running session (`live`) shows whether it uses Remote Control. */
  async list(): Promise<SessionSummary[]> {
    const live = await this.catalog.readLive(this.home).catch(() => undefined);
    const fs = this.catalog.fs;
    const found = await scan({ home: this.home, path: this.path, fs });

    // Remember which session ids belong together: the same Remote Control connection (exact), and the first session of
    // a running process (exact, Linux only). Then a `/clear` that no running file showed is matched by time.
    if (live) {
      await this.catalog.chains.observe(
        [...live].flatMap(([id, liveInfo]) => (liveInfo.bridgeId ? [[liveInfo.bridgeId, id] as const] : [])),
      );
      for (const [id, liveInfo] of live)
        if (liveInfo.firstSessionId) await this.catalog.chains.link(liveInfo.firstSessionId, id);
    }

    for (const [pred, succ] of matchByTime(found)) await this.catalog.chains.link(pred, succ);
    const byId = new Map(found.map((item) => [item.id, item]));
    const hidden = new Set<string>();
    const chainOf = new Map<string, Found[]>();

    for (const item of found) {
      if (hidden.has(item.id)) continue;
      const members = (await this.catalog.chains.chainOf(item.id)).flatMap((id) => byId.get(id) ?? []);
      if (members.length < 2) continue;
      // The newest transcript of the chain is the one that shows. The others are folded into it.
      const head = members.reduce((member, candidate) => (candidate.mtimeMs > member.mtimeMs ? candidate : member));
      for (const member of members) if (member !== head) hidden.add(member.id);
      chainOf.set(
        head.id,
        members.filter((member) => member !== head),
      );
    }

    const sessions = await mapLimit(
      found.filter((item) => !hidden.has(item.id)),
      NAME_READS,
      async (item): Promise<SessionSummary> => {
        const earlier = chainOf.get(item.id);
        const first = earlier?.length
          ? earlier.reduce((total, entry) => ((entry.startedAt ?? "") < (total.startedAt ?? "") ? entry : total))
          : undefined;
        const lastActiveAt = new Date(item.mtimeMs).toISOString();
        const sessionSummary: SessionSummary = {
          id: item.id,
          root: item.root,
          startedAt: first?.startedAt ?? item.startedAt ?? lastActiveAt,
          lastActiveAt,
        };
        const liveInfo = live?.get(item.id);
        // The order of the sources is chooseName (sessionnames.ts). The name memory then decides: a name that the launcher
        // learned from a better source stays, also after `/compact`.
        const liveName = tidy(liveInfo?.name);
        const chainInfo = first ? await nameInfoOf(fs, first, this.catalog.names) : undefined;
        const ownInfo = await nameInfoOf(fs, item, this.catalog.names);
        const picked = chooseName({
          live: liveName,
          liveIsDefault: liveInfo?.nameIsDefault,
          chain: chainInfo?.name,
          transcript: ownInfo?.name,
        });
        let cand: NameInfo | undefined;

        if (picked !== undefined) {
          const source =
            !liveInfo?.nameIsDefault && picked === liveName
              ? "live"
              : picked === chainInfo?.name
                ? chainInfo.source
                : picked === ownInfo?.name
                  ? ownInfo.source
                  : "default";
          cand = { name: picked, source };
        }

        const chain = [item.id, ...(earlier ?? []).map((entry) => entry.id)];
        const name = (await this.catalog.nameMemory.resolve({ id: item.id, chain, candidate: cand, file: item.file }))
          ?.name;
        if (name) sessionSummary.name = name;

        // Field by field: nothing else from the running-session file reaches the answer.
        if (liveInfo) sessionSummary.live = liveOf(liveInfo);

        if (item.branch) sessionSummary.branch = item.branch;
        if (earlier?.length)
          sessionSummary.earlier = earlier
            .sort((left, right) => ((left.startedAt ?? "") < (right.startedAt ?? "") ? -1 : 1))
            .map((session) => session.id);
        return sessionSummary;
      },
    );
    return sessions.sort((sessionSummary, session) =>
      sessionSummary.lastActiveAt < session.lastActiveAt
        ? 1
        : sessionSummary.lastActiveAt > session.lastActiveAt
          ? -1
          : 0,
    );
  }

  /**
   * The session with this id, or undefined for a bad id or no transcript.
   * Its root is lexical only: the caller must check the real place of `root` before it reads files there.
   */
  async find(id: string): Promise<Session | undefined> {
    if (!SESSION_ID.test(id)) return undefined;
    const found = await scan({ home: this.home, path: this.path, fs: this.catalog.fs, only: id });
    return found[0] ? new Session(this, found[0]) : undefined;
  }
}
