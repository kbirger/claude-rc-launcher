export type SpawnMode = "same-dir" | "worktree";
export interface InstanceSettings {
  createSession: boolean;
  spawnMode: SpawnMode;
  /** Whether a session of the instance may ask the hub for SSH access. Needs a Linux node. */
  sshRequests: boolean;
}
export type SettingsPatch = Partial<InstanceSettings>;

export const DEFAULT_SETTINGS: InstanceSettings = {
  createSession: true,
  spawnMode: "same-dir",
  sshRequests: false,
};

export interface SettingsHelp {
  settings: {
    key: "createSession" | "spawnMode" | "sshRequests";
    label: string;
    values: { value: boolean | string; label: string; explanation: string }[];
    limits?: string;
  }[];
  /** The settings that a start with no settings gets on this node. An older node does not send them. */
  defaults?: InstanceSettings;
}

export function settingsFromArgs(args: string[]): InstanceSettings {
  let spawnMode: SpawnMode = DEFAULT_SETTINGS.spawnMode;
  let createSession = DEFAULT_SETTINGS.createSession;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    let value: string | undefined;
    if (arg === "--spawn") value = args[index + 1];
    else if (arg.startsWith("--spawn=")) value = arg.slice("--spawn=".length);
    else if (arg === "--no-create-session-in-dir") createSession = false;
    else if (arg === "--create-session-in-dir") createSession = true;
    if (value === "same-dir" || value === "worktree") spawnMode = value;
  }

  return { createSession, spawnMode, sshRequests: DEFAULT_SETTINGS.sshRequests };
}

export function argsWith(base: string[], instanceSettings: InstanceSettings): string[] {
  const out: string[] = [];

  for (let index = 0; index < base.length; index++) {
    const arg = base[index];
    if (arg === "--spawn") index++;
    else if (arg.startsWith("--spawn=") || arg === "--create-session-in-dir" || arg === "--no-create-session-in-dir")
      continue;
    else out.push(arg);
  }

  out.push("--spawn", instanceSettings.spawnMode);
  if (!instanceSettings.createSession) out.push("--no-create-session-in-dir");
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
            "When the server starts, it makes one empty session. After a crash or a restart, each recorded session wakes when you open it on claude.ai. This works for about four hours.",
        },
        {
          value: false,
          label: "Off",
          explanation:
            "The server starts with no session. When a client asks, the server makes a session. At each stop, claude.ai archives the sessions of the server, so none comes back after a crash or a restart. While the folder holds a recoverable session, the server refuses to start.",
        },
      ],
      limits:
        "A change restarts a running instance and checks that it stays up. A paused instance only saves the change.",
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
      limits:
        "A change restarts a running instance and checks that it stays up. A paused instance only saves the change. The worktree mode needs a git repository.",
    },
    {
      key: "sshRequests",
      label: "Allow SSH requests",
      values: [
        {
          value: false,
          label: "Off",
          explanation: "The sessions of this instance cannot ask for SSH access to a target.",
        },
        {
          value: true,
          label: "On",
          explanation:
            "A session can ask for SSH access to a target with claude-rc ssh request. An admin must approve each request on the hub.",
        },
      ],
      limits:
        "A change restarts a running instance and checks that it stays up. A paused instance only saves the change. This needs a Linux node.",
    },
  ],
};

/** The help of a node on this platform. A Windows node cannot hold an SSH grant, so its help has no SSH setting and the UI never offers it. */
export function settingsHelpFor(platform: NodeJS.Platform): SettingsHelp {
  if (platform !== "win32") return SETTINGS_HELP;
  return { ...SETTINGS_HELP, settings: SETTINGS_HELP.settings.filter((setting) => setting.key !== "sshRequests") };
}
