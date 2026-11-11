import type { HostInfo } from "../hosts";
import type { UpdateEntry } from "./api";

// TEMPORARY: canned states to try the Updates page and its animation without a real update.
// Delete this file, UpdateMockPanel.svelte and their use in routes/updates/+page.svelte when the animation is settled.
export type MockName = "none" | "available" | "started" | "complete";
export const MOCK_NAMES: { name: MockName; label: string }[] = [
  { name: "none", label: "No updates" },
  { name: "available", label: "Updates available" },
  { name: "started", label: "Hub update started" },
  { name: "complete", label: "Update complete" },
];

const OLD = "0.11.0";
const NEW = "0.12.0";

export function mockState(name: MockName, now = new Date()): { hosts: HostInfo[]; updates: UpdateEntry[] } {
  const behind = name === "available" || name === "started";
  const version = behind ? OLD : NEW;
  const hosts: HostInfo[] = [
    { id: "local", name: "hub", status: "ok", version, clientVersion: version, target: NEW, stale: behind },
    { id: "node-1", name: "node-1", status: "ok", version, clientVersion: version, target: NEW, stale: behind, platform: "linux" },
  ];
  const started = now.toISOString();
  const updates: UpdateEntry[] = [];
  if (name === "started") updates.push({ host: "local", startedAt: started, startedBy: "mock", from: OLD, status: "running", step: "downloading" });
  if (name === "complete") updates.push({ host: "local", startedAt: new Date(now.getTime() - 20_000).toISOString(), finishedAt: started, startedBy: "mock", from: OLD, to: NEW, status: "updated" });
  return { hosts, updates };
}
