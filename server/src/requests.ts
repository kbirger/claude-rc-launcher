import type { Context } from "hono";
import { HttpError } from "./instances";
import type { SettingsPatch, SpawnMode } from "./instancesettings";
import { RELEASE_TAG_RE } from "./release";
import { normalizeVersion } from "./versions";

/**
 * Reading and validating request bodies. The local routes (`app.ts`), the routes that forward to a node
 * (`hosts.ts`) and the host admin API (`hostadmin.ts`) all use this module, so a local host and a remote host accept
 * the same input and a new field is added in one place.
 */

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export async function readJson(context: Context): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

export async function readObject(context: Context): Promise<Record<string, unknown>> {
  const body = await readJson(context);
  if (!isObject(body)) throw new HttpError(400, "body must be an object");
  return body;
}

/** `undefined` when absent. Throws 400 for a value that is not a non-empty string. */
function optionalUser(body: Record<string, unknown>): string | undefined {
  if (body.user === undefined) return undefined;
  if (typeof body.user !== "string") throw new HttpError(400, "user must be a string");
  if (body.user === "") throw new HttpError(400, "user must not be empty");
  return body.user;
}

const SPAWN_MODES: readonly SpawnMode[] = ["same-dir", "worktree"];

function optionalCreateSession(body: Record<string, unknown>): boolean | undefined {
  if (body.createSession === undefined) return undefined;
  if (typeof body.createSession !== "boolean") throw new HttpError(400, "createSession must be a boolean");
  return body.createSession;
}

function optionalSpawnMode(body: Record<string, unknown>): SpawnMode | undefined {
  if (body.spawnMode === undefined) return undefined;
  if (typeof body.spawnMode !== "string" || !SPAWN_MODES.includes(body.spawnMode as SpawnMode))
    throw new HttpError(400, "spawnMode must be same-dir or worktree");
  return body.spawnMode as SpawnMode;
}

export interface StartRequest {
  path: string;
  name?: string;
  user?: string;
  addTrust?: boolean;
  createSession?: boolean;
  spawnMode?: SpawnMode;
}

/** The body of `PATCH /instances/:id`. At least one known field is required. An unknown field is an error. */
export function parseSettingsPatch(body: unknown): SettingsPatch {
  if (!isObject(body)) throw new HttpError(400, "body must be an object");

  for (const key of Object.keys(body)) {
    if (key !== "createSession" && key !== "spawnMode") throw new HttpError(400, `unknown field: ${key}`);
  }

  const createSession = optionalCreateSession(body);
  const spawnMode = optionalSpawnMode(body);
  if (createSession === undefined && spawnMode === undefined)
    throw new HttpError(400, "at least one of createSession and spawnMode is required");
  return {
    ...(createSession === undefined ? {} : { createSession }),
    ...(spawnMode === undefined ? {} : { spawnMode }),
  };
}

/** The body of `POST /instances`. Only the known fields are returned. */
export function parseStartRequest(body: unknown): StartRequest {
  if (!isObject(body)) throw new HttpError(400, "body must be an object");
  if (typeof body.path !== "string" || !body.path) throw new HttpError(400, "path is required");
  if (body.name !== undefined && typeof body.name !== "string") throw new HttpError(400, "name must be a string");
  const user = optionalUser(body);
  if (body.addTrust !== undefined && typeof body.addTrust !== "boolean")
    throw new HttpError(400, "addTrust must be a boolean");
  const createSession = optionalCreateSession(body);
  const spawnMode = optionalSpawnMode(body);
  return {
    path: body.path,
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(user === undefined ? {} : { user }),
    ...(body.addTrust === undefined ? {} : { addTrust: body.addTrust }),
    ...(createSession === undefined ? {} : { createSession }),
    ...(spawnMode === undefined ? {} : { spawnMode }),
  };
}

export interface MkdirRequest {
  parent: string;
  name: string;
  user?: string;
}

/** The body of `POST /fs/mkdir`. Only the known fields are returned. */
export function parseMkdirRequest(body: unknown): MkdirRequest {
  if (!isObject(body) || typeof body.parent !== "string" || typeof body.name !== "string") {
    throw new HttpError(400, "parent and name are required strings");
  }

  const user = optionalUser(body);
  return { parent: body.parent, name: body.name, ...(user === undefined ? {} : { user }) };
}

export interface CloneRequest {
  repo: string;
  parent: string;
  user?: string;
}

/** The body of `POST /clone`. Only the known fields are returned. */
export function parseCloneRequest(body: unknown): CloneRequest {
  if (!isObject(body)) throw new HttpError(400, "body must be an object");
  if (typeof body.repo !== "string" || typeof body.parent !== "string")
    throw new HttpError(400, "repo and parent are required strings");
  const user = optionalUser(body);
  return { repo: body.repo, parent: body.parent, ...(user === undefined ? {} : { user }) };
}

export interface LoginRequest {
  user?: string;
}

/** The body of `POST /github/login`. An empty object means no user. */
export function parseLoginRequest(body: unknown): LoginRequest {
  if (!isObject(body)) throw new HttpError(400, "body must be an object");
  const user = optionalUser(body);
  return user === undefined ? {} : { user };
}

export interface UpdateRequest {
  release?: string;
}

/** The body of `POST /update`. Only `release` is kept, and only as a version tag: it becomes part of a download URL. */
export function parseUpdateRequest(body: unknown): UpdateRequest {
  if (!isObject(body)) throw new HttpError(400, "body must be an object");
  if (body.release === undefined) return {};
  if (typeof body.release !== "string" || !RELEASE_TAG_RE.test(body.release))
    throw new HttpError(400, "release must be a version tag such as v1.2.3");
  return { release: `v${normalizeVersion(body.release)}` };
}
