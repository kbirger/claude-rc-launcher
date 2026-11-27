// What other features may import from auth. A feature imports auth/ only through this file.
export { certFingerprint, signProof } from "./hubproof";
export type { HubKey, ProofRequest } from "./hubproof";
export type { User } from "./user";
