export type AppNames = { slug: string; name: string; provider: string };
export type Settings = {
  claim: string;
  scope: string;
  mappingName: string;
  groups: { name: string; role: string }[];
  adminGroup: string;
  adminUser?: string;
  webApp: AppNames;
  cliApp: AppNames;
  oldHub: { application: string; provider: string };
  removeOldHub: boolean;
};

export const DEFAULTS: Settings = {
  claim: "clauderc_role",
  scope: "clauderc",
  mappingName: "clauderc role",
  groups: [
    { name: "ak-clauderc-admins", role: "admin" },
    { name: "ak-clauderc-writers", role: "write" },
    { name: "ak-clauderc-ro", role: "read" },
  ],
  adminGroup: "ak-clauderc-admins",
  webApp: { slug: "claude-rc-launcher", name: "Claude RC launcher", provider: "Provider for Claude RC launcher" },
  cliApp: { slug: "claude-rc-cli", name: "Claude RC CLI", provider: "Provider for Claude RC CLI" },
  oldHub: { application: "claude-rc-hub", provider: "Provider for Claude RC hub" },
  removeOldHub: false,
};
