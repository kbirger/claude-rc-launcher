import { isValidDirName } from "./fsapi";
import { HttpError } from "./instances";

export type RepoRef = { owner: string; repo: string; url: string; dirName: string };

const PART = /^[A-Za-z0-9._-]+$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*)$/;
const BAD = "enter a GitHub link or owner/repo";

export function parseRepoLink(input: string): RepoRef {
  const s = typeof input === "string" ? input.trim() : "";
  let segments: string[];
  if (/^https?:\/\//i.test(s) || /^github\.com\//i.test(s)) {
    let u: URL;
    try {
      u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    } catch {
      throw new HttpError(400, BAD);
    }
    if (u.protocol !== "https:" || u.hostname.toLowerCase() !== "github.com" || u.port) {
      throw new HttpError(400, "only github.com is supported (use an https://github.com link)");
    }
    if (u.username || u.password) {
      throw new HttpError(400, "links with credentials are not allowed");
    }
    segments = u.pathname.split("/").filter(Boolean);
  } else {
    if (s.includes(":")) {
      throw new HttpError(400, "SSH addresses are not supported; use an https://github.com link");
    }
    segments = s.split("/");
    if (segments.length > 1 && /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(segments[0]!)) {
      throw new HttpError(400, "only github.com is supported (use an https://github.com link)");
    }
    if (segments.length !== 2) throw new HttpError(400, BAD);
  }
  if (segments.length < 2) throw new HttpError(400, BAD);
  const owner = segments[0]!;
  let repo = segments[1]!;
  if (repo.endsWith(".git")) repo = repo.slice(0, -4);
  if (!OWNER.test(owner)) {
    throw new HttpError(400, "invalid owner: use letters, digits and '-', starting with a letter or digit");
  }
  if (!PART.test(repo)) {
    throw new HttpError(400, "repo may only use letters, digits, '.', '_' and '-'");
  }
  if (repo.startsWith("-")) {
    throw new HttpError(400, `repo name "${repo}" cannot be used as a folder name because it starts with '-'`);
  }
  if (!isValidDirName(repo)) {
    throw new HttpError(400, `repo name "${repo}" is not a valid folder name`);
  }
  return { owner, repo, url: `https://github.com/${owner}/${repo}.git`, dirName: repo };
}
