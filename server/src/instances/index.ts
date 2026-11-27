// What other features may import from instances. A feature imports instances/ only through this file.
export {
  ChangeLock,
  isValidPatch,
  PROBE_INTERVAL_MS,
  REFUSED_EXIT_CODE,
  sameSettings,
  SETTLE_MS,
  settleReason,
  waitSettled,
} from "./ChangeLock";
export type { ProbeResult } from "./ChangeLock";
export type { Instance, Instances, UpdateResult, UsersInfo } from "./InstanceService";
export { repoKind } from "./repokind";
export type { RepoKind } from "./repokind";
export {
  parseCloneRequest,
  parseLoginRequest,
  parseMkdirRequest,
  parseSettingsPatch,
  parseStartRequest,
} from "./requests";
export { argsWith, settingsFromArgs } from "./settings";
export type { InstanceSettings, SettingsPatch, SpawnMode } from "./settings";
export type { TrustOwner, TrustStore } from "./trust";
export { defaultName, instanceId, isValidName, runAsFor, SSH_RUN_DIR } from "./unit";
