import { cloneStart, cloneStatus, githubLoginStart, githubLoginStatus, listRepos } from "./api";

export const CLONE_POLL_MS = 2000;
export const LOGIN_POLL_MS = 3000;
export const MAX_FAILURES = 5;

/** A job query gives up at once on a 404 (unknown job) and after MAX_FAILURES failures in a row. failureCount starts at 0. */
export const jobRetry = (failureCount: number, error: unknown): boolean =>
  (error as { status?: unknown } | null)?.status !== 404 && failureCount < MAX_FAILURES - 1;

export const isCloneDone = (s?: { state: string }): boolean => s?.state === "done" || s?.state === "failed";
export const isLoginDone = (s?: { state: string }): boolean => s !== undefined && s.state !== "pending";

type JobState<T> = { state: { status: string; data: T | undefined } };
// After a give-up the status is "error" while the data still says the job runs, so polling must stop on the status too.
const pollUntil = <T extends { state: string }>(done: (s?: T) => boolean, ms: number) => (q: JobState<T>): number | false =>
  q.state.status === "error" || done(q.state.data) ? false : ms;

export const reposQuery = (host: string, user?: string) => ({
  queryKey: ["repos", host, user ?? ""] as const,
  queryFn: () => listRepos(host, user),
  staleTime: 30_000,
  retry: false as const,
});

type CloneStatus = Awaited<ReturnType<typeof cloneStatus>>;
type LoginStatus = Awaited<ReturnType<typeof githubLoginStatus>>;

// gcTime 0: a finished job is never read from the cache again.
export const cloneJobQuery = (host: string, id: string) => ({
  // While no job runs, the model passes id "" with enabled false, so ["clone", host, ""] is a placeholder that never fetches.
  queryKey: ["clone", host, id] as const,
  queryFn: () => cloneStatus(host, id),
  gcTime: 0,
  retry: jobRetry,
  retryDelay: CLONE_POLL_MS,
  refetchInterval: pollUntil<CloneStatus>(isCloneDone, CLONE_POLL_MS),
});

export const loginJobQuery = (host: string, id: string) => ({
  queryKey: ["github-login", host, id] as const,
  queryFn: () => githubLoginStatus(host, id),
  gcTime: 0,
  retry: jobRetry,
  retryDelay: LOGIN_POLL_MS,
  refetchInterval: pollUntil<LoginStatus>(isLoginDone, LOGIN_POLL_MS),
});

export type CloneStartArgs = { repo: string; parent: string; user?: string };
export type LoginStartArgs = { user?: string };

export const cloneStartMutation = (host: string) => ({
  mutationKey: ["clone-start", host] as const,
  mutationFn: (v: CloneStartArgs) => cloneStart(host, v.repo, v.parent, v.user),
});

export const githubLoginStartMutation = (host: string) => ({
  mutationKey: ["github-login-start", host] as const,
  mutationFn: (v: LoginStartArgs) => githubLoginStart(host, v.user),
});
