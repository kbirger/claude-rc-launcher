import { HttpError } from "../shared/HttpError";
import { isObject } from "../shared/requests";
import { normalizeVersion } from "../shared/versions";
import { RELEASE_TAG_RE } from "./release";

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
