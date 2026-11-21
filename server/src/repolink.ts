import { isValidDirName } from "./fsapi";
import { HttpError } from "./instances";

export interface RepoRef {
  owner: string;
  repo: string;
  url: string;
  dirName: string;
}

const PART = /^[A-Za-z0-9._-]+$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*)$/;
const BAD = "enter a GitHub link or owner/repo";

export function parseRepoLink(input: string): RepoRef {
  const trimmed = typeof input === "string" ? input.trim() : "";
  let segments: string[];

  if (/^https?:\/\//i.test(trimmed) || /^github\.com\//i.test(trimmed)) {
    let parsedUrl: URL;

    try {
      parsedUrl = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    } catch {
      throw new HttpError(400, BAD);
    }

    if (parsedUrl.protocol !== "https:" || parsedUrl.hostname.toLowerCase() !== "github.com" || parsedUrl.port) {
      throw new HttpError(400, "only github.com is supported (use an https://github.com link)");
    }

    if (parsedUrl.username || parsedUrl.password) {
      throw new HttpError(400, "links with credentials are not allowed");
    }

    segments = parsedUrl.pathname.split("/").filter(Boolean);
  } else {
    if (trimmed.includes(":")) {
      throw new HttpError(400, "SSH addresses are not supported; use an https://github.com link");
    }

    segments = trimmed.split("/");

    if (segments.length > 1 && /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(segments[0])) {
      throw new HttpError(400, "only github.com is supported (use an https://github.com link)");
    }

    if (segments.length !== 2) throw new HttpError(400, BAD);
  }

  if (segments.length < 2) throw new HttpError(400, BAD);
  const owner = segments[0];
  let repo = segments[1];
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
