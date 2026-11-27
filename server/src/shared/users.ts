import { readFile, stat } from "node:fs/promises";

export interface SystemUser {
  name: string;
  uid: number;
  gid: number;
  home: string;
}

export interface UserDirectory {
  list(): Promise<SystemUser[]>;
  get(name: string): Promise<SystemUser | undefined>;
  /** The raw passwd entry for a valid name, without the list rules (uid, shell, home). For service accounts. */
  lookup(name: string): Promise<SystemUser | undefined>;
}

export const USER_NAME_RE = /^[a-z_][a-z0-9._-]{0,31}\$?$/i;

const NO_LOGIN = /(^|\/)(nologin|false)$/;

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export function passwdDirectory(
  options: {
    readPasswd?: () => Promise<string>;
    homeExists?: (home: string) => Promise<boolean>;
  } = {},
): UserDirectory {
  const readPasswd = options.readPasswd ?? (() => readFile("/etc/passwd", "utf8"));
  const homeExists = options.homeExists ?? dirExists;

  /** Every well-formed passwd entry with a valid name, plus its shell. */
  async function entries(): Promise<(SystemUser & { shell: string })[]> {
    const out: (SystemUser & { shell: string })[] = [];

    for (const line of (await readPasswd()).split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const parts = line.split(":");
      if (parts.length < 7) continue;
      const [name, , uidS, gidS, , home, shell] = parts;
      if (!USER_NAME_RE.test(name)) continue;
      if (!/^\d+$/.test(uidS) || !/^\d+$/.test(gidS)) continue;
      out.push({ name, uid: Number(uidS), gid: Number(gidS), home, shell });
    }

    return out;
  }

  async function list(): Promise<SystemUser[]> {
    const out: SystemUser[] = [];

    for (const { name, uid, gid, home, shell } of await entries()) {
      // root is always in the list. The rules below apply to every other account.
      if (name !== "root") {
        if (uid !== 0 && uid < 1000) continue;
        if (NO_LOGIN.test(shell)) continue;
        if (!home || !(await homeExists(home))) continue;
      }

      out.push({ name, uid, gid, home });
    }

    return out.sort((systemUser, right) => systemUser.uid - right.uid);
  }

  return {
    list,
    async get(name) {
      if (!USER_NAME_RE.test(name)) return undefined;
      return (await list()).find((systemUser) => systemUser.name === name);
    },
    async lookup(name) {
      if (!USER_NAME_RE.test(name)) return undefined;
      const user = (await entries()).find((candidate) => candidate.name === name);
      return user && { name: user.name, uid: user.uid, gid: user.gid, home: user.home };
    },
  };
}
