import path from "node:path";
import type { ConfigIo } from "./parse";

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const isAbs = (file: string) => path.isAbsolute(file) || path.win32.isAbsolute(file);

/** A TOML table being validated: tracks consumed keys so unknown ones are reported by dotted path. */
export class Tbl {
  private seen = new Set<string>();
  constructor(
    readonly v: Record<string, unknown>,
    readonly p: string,
    readonly problems: string[],
    readonly io: ConfigIo,
  ) {}
  path(key: string) {
    return this.p ? `${this.p}.${key}` : key;
  }
  has(key: string) {
    return this.v[key] !== undefined;
  }
  private take(key: string) {
    this.seen.add(key);
    return this.v[key];
  }
  str(key: string, options: { req?: boolean } = {}): string | undefined {
    const raw = this.take(key);

    if (raw === undefined) {
      if (options.req) this.problems.push(`${this.path(key)} is required`);
      return undefined;
    }

    if (typeof raw !== "string" || raw === "") {
      this.problems.push(`${this.path(key)} must be a non-empty string`);
      return undefined;
    }

    return raw;
  }
  bool(key: string): boolean | undefined {
    const raw = this.take(key);
    if (raw === undefined) return undefined;

    if (typeof raw !== "boolean") {
      this.problems.push(`${this.path(key)} must be true or false`);
      return undefined;
    }

    return raw;
  }
  port(key: string): number | undefined {
    const raw = this.take(key);
    if (raw === undefined) return undefined;

    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 65535) {
      this.problems.push(`${this.path(key)} is invalid: ${typeof raw === "string" ? raw : JSON.stringify(raw)}`);
      return undefined;
    }

    return raw;
  }
  strs(key: string, options: { abs?: boolean; nonEmpty?: boolean } = {}): string[] | undefined {
    const raw = this.take(key);
    if (raw === undefined) return undefined;

    if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string" || item === "")) {
      this.problems.push(`${this.path(key)} must be an array of non-empty strings`);
      return undefined;
    }

    if (options.nonEmpty && raw.length === 0) {
      this.problems.push(`${this.path(key)} must not be empty`);
      return undefined;
    }

    if (options.abs)
      for (const value of raw as string[])
        if (!isAbs(value)) this.problems.push(`${this.path(key)} entry must be an absolute path: ${value}`);
    return raw as string[];
  }
  absStr(key: string): string | undefined {
    const text = this.str(key);
    if (text !== undefined && !isAbs(text)) this.problems.push(`${this.path(key)} must be an absolute path: ${text}`);
    return text;
  }
  table(key: string): Tbl | undefined {
    const raw = this.take(key);
    if (raw === undefined) return undefined;

    if (!isObject(raw)) {
      this.problems.push(`${this.path(key)} must be a table`);
      return undefined;
    }

    return new Tbl(raw, this.path(key), this.problems, this.io);
  }
  tables(key: string): Tbl[] | undefined {
    const raw = this.take(key);
    if (raw === undefined) return undefined;

    if (!Array.isArray(raw) || raw.some((element) => !isObject(element))) {
      this.problems.push(`${this.path(key)} must be an array of tables`);
      return undefined;
    }

    return (raw as Record<string, unknown>[]).map(
      (record, index) => new Tbl(record, `${this.path(key)}[${index}]`, this.problems, this.io),
    );
  }
  /** Reads the file named by `<key>` (e.g. "client_secret_file"). */
  file(key: string, kind: "secret" | "public", options: { req?: boolean } = {}): string | undefined {
    const text = this.str(key, options);
    if (text === undefined) return undefined;

    try {
      return this.io.readFile(text, kind);
    } catch (error) {
      this.problems.push(`${this.path(key)}: ${(error as Error).message}`);
      return undefined;
    }
  }
  /** Marks keys as intentionally ignored here (reported elsewhere). */
  skip(...ks: string[]) {
    for (const key of ks) this.seen.add(key);
  }
  finish() {
    for (const key of Object.keys(this.v)) if (!this.seen.has(key)) this.problems.push(`unknown key ${this.path(key)}`);
  }
}
