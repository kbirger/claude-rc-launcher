export type SpawnMode = "same-dir" | "worktree";
export type InstanceSettings = { createSession: boolean; spawnMode: SpawnMode };
export type SettingsPatch = Partial<InstanceSettings>;

export const DEFAULT_SETTINGS: InstanceSettings = { createSession: true, spawnMode: "same-dir" };

export type SettingsHelp = {
  settings: {
    key: "createSession" | "spawnMode";
    label: string;
    values: { value: boolean | string; label: string; explanation: string }[];
    limits?: string;
  }[];
};

export function settingsFromArgs(args: string[]): InstanceSettings {
  let spawnMode: SpawnMode = DEFAULT_SETTINGS.spawnMode;
  let createSession = DEFAULT_SETTINGS.createSession;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let v: string | undefined;
    if (a === "--spawn") v = args[i + 1];
    else if (a.startsWith("--spawn=")) v = a.slice("--spawn=".length);
    else if (a === "--no-create-session-in-dir") createSession = false;
    else if (a === "--create-session-in-dir") createSession = true;
    if (v === "same-dir" || v === "worktree") spawnMode = v;
  }
  return { createSession, spawnMode };
}

export function argsWith(base: string[], s: InstanceSettings): string[] {
  const out: string[] = [];
  for (let i = 0; i < base.length; i++) {
    const a = base[i];
    if (a === "--spawn") i++;
    else if (a.startsWith("--spawn=") || a === "--create-session-in-dir" || a === "--no-create-session-in-dir") continue;
    else out.push(a);
  }
  out.push("--spawn", s.spawnMode);
  if (!s.createSession) out.push("--no-create-session-in-dir");
  return out;
}

export const SETTINGS_HELP: SettingsHelp = {
  settings: [
    {
      key: "createSession",
      label: "Create a session at start",
      values: [
        {
          value: true,
          label: "On",
          explanation:
            "When the server starts, it makes one empty session. After a crash or a restart, it brings back its recorded sessions.",
        },
        {
          value: false,
          label: "Off",
          explanation:
            "The server starts with no session. When a client asks, the server makes a session. While the folder holds a recoverable session, the server refuses to restart, so crash recovery does not work.",
        },
      ],
      limits: "A change restarts the instance.",
    },
    {
      key: "spawnMode",
      label: "Session folders",
      values: [
        {
          value: "same-dir",
          label: "Same folder",
          explanation: "Every session works in the same folder. Two sessions can change the same files.",
        },
        {
          value: "worktree",
          label: "Worktree",
          explanation:
            "Each new session gets its own git worktree. The first session stays in the folder. The folder must be a git repository.",
        },
      ],
      limits: "A change restarts the instance. The worktree mode needs a git repository.",
    },
  ],
};
