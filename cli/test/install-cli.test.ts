import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.join(import.meta.dir, "../../install-cli.sh");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const REL = "https://github.com/kbirger/claude-rc-launcher/releases";

/** A directory of fake `curl`, `uname` and `sudo`, and a fake release to download from. */
function world(o: { os?: string; arch?: string; sums?: (asset: string, body: string) => string; assets?: string[] } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rc-inst-"));
  const shims = path.join(dir, "shims");
  const release = path.join(dir, "release");
  const prefix = path.join(dir, "bin");
  mkdirSync(shims);
  mkdirSync(release);
  const log = path.join(dir, "log");
  writeFileSync(log, "");
  // The installed program prints its arguments and exits with the code in FAKE_EXIT.
  const body = '#!/bin/sh\necho "ran: $*"\nexit "${FAKE_EXIT:-0}"\n';
  for (const asset of o.assets ?? ["claude-rc-linux-x64", "claude-rc-linux-arm64", "claude-rc-darwin-x64", "claude-rc-darwin-arm64"]) {
    writeFileSync(path.join(release, asset), body);
  }
  const sums = (o.assets ?? ["claude-rc-linux-x64", "claude-rc-linux-arm64", "claude-rc-darwin-x64", "claude-rc-darwin-arm64"])
    .map((a) => (o.sums ? o.sums(a, body) : `${sha(body)}  ${a}`))
    .join("\n");
  writeFileSync(path.join(release, "SHA256SUMS"), sums + "\n");
  const sh = (name: string, text: string) => {
    writeFileSync(path.join(shims, name), `#!/bin/sh\n${text}\n`);
    chmodSync(path.join(shims, name), 0o755);
  };
  // curl -fsSL -o <file> <url>: copies release/<basename of url> and records the url.
  sh("curl", `echo "$@" >> ${log}\nout=""; url=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; -*) shift;; *) url="$1"; shift;; esac; done\nf="${release}/$(basename "$url")"\n[ -f "$f" ] || { echo "curl: (22) 404 $url" >&2; exit 22; }\ncp "$f" "$out"`);
  sh("uname", `case "$1" in -s) echo "${o.os ?? "Linux"}";; -m) echo "${o.arch ?? "x86_64"}";; esac`);
  sh("sudo", `echo "sudo $*" >> ${log}\nexec "$@"`);
  const run = (args: string[] = [], env: Record<string, string> = {}) =>
    Bun.spawnSync(["sh", SCRIPT, ...args], { env: { PATH: `${shims}:/usr/bin:/bin`, HOME: dir, CLAUDE_RC_PREFIX: prefix, ...env }, stdin: null });
  return { dir, prefix, run, urls: () => readFileSync(log, "utf8"), installed: () => path.join(prefix, "claude-rc") };
}
const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b ?? new Uint8Array());

describe("install-cli.sh", () => {
  test("installs the CLI for Linux x64 from the latest release, mode 755, and checks it against SHA256SUMS", () => {
    const w = world();
    const r = w.run();
    expect(r.exitCode).toBe(0);
    expect(existsSync(w.installed())).toBe(true);
    if (process.platform !== "win32") expect(statSync(w.installed()).mode & 0o777).toBe(0o755);
    expect(readFileSync(w.installed(), "utf8")).toContain("ran:");
    expect(w.urls()).toContain(`${REL}/latest/download/claude-rc-linux-x64`);
    expect(w.urls()).toContain(`${REL}/latest/download/SHA256SUMS`);
    expect(text(r.stdout)).toContain(w.installed());
  });

  test("maps the CPU and the OS: arm64, aarch64, macOS", () => {
    for (const [uos, arch, asset] of [["Linux", "aarch64", "claude-rc-linux-arm64"], ["Linux", "arm64", "claude-rc-linux-arm64"], ["Darwin", "arm64", "claude-rc-darwin-arm64"], ["Darwin", "x86_64", "claude-rc-darwin-x64"], ["Linux", "amd64", "claude-rc-linux-x64"]] as const) {
      const w = world({ os: uos, arch });
      expect([uos, arch, w.run().exitCode]).toEqual([uos, arch, 0]);
      expect(w.urls()).toContain(`/latest/download/${asset}`);
    }
  });

  test("an unsupported OS or CPU stops before downloading anything", () => {
    for (const [uos, arch, msg] of [["FreeBSD", "x86_64", "FreeBSD"], ["MINGW64_NT-10.0", "x86_64", "Windows"], ["Linux", "riscv64", "riscv64"]] as const) {
      const w = world({ os: uos, arch });
      const r = w.run();
      expect([uos, r.exitCode === 0]).toEqual([uos, false]);
      expect(text(r.stderr)).toContain(msg);
      expect(w.urls()).toBe("");
      expect(existsSync(w.installed())).toBe(false);
    }
  });

  test("a checksum mismatch installs nothing and says so", () => {
    const w = world({ sums: (a) => `${"1".repeat(64)}  ${a}` });
    const r = w.run();
    expect(r.exitCode).not.toBe(0);
    expect(text(r.stderr)).toContain("checksum");
    expect(existsSync(w.installed())).toBe(false);
  });

  test("a SHA256SUMS without the asset installs nothing", () => {
    const w = world({ sums: (a) => `${sha("x")}  other-${a}` });
    const r = w.run();
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(w.installed())).toBe(false);
  });

  test("a missing release asset stops with the URL", () => {
    const w = world({ assets: [] });
    const r = w.run();
    expect(r.exitCode).not.toBe(0);
    expect(text(r.stderr)).toContain("claude-rc-linux-x64");
  });

  test("CLAUDE_RC_VERSION picks that release", () => {
    const w = world();
    expect(w.run([], { CLAUDE_RC_VERSION: "v0.2.0" }).exitCode).toBe(0);
    expect(w.urls()).toContain(`${REL}/download/v0.2.0/claude-rc-linux-x64`);
  });

  test("arguments after the script are passed to claude-rc, and its exit code is returned", () => {
    const w = world();
    const r = w.run(["node", "setup", "--hub", "https://rc.example.com", "--listen", "10.0.0.5"]);
    expect(r.exitCode).toBe(0);
    expect(text(r.stdout)).toContain("ran: node setup --hub https://rc.example.com --listen 10.0.0.5");
    const bad = w.run(["whoami"], { FAKE_EXIT: "2" });
    expect(bad.exitCode).toBe(2);
  });

  test("the install is replaced atomically: a running old copy is not overwritten in place", () => {
    const w = world();
    mkdirSync(w.prefix, { recursive: true });
    writeFileSync(w.installed(), "old");
    expect(w.run().exitCode).toBe(0);
    expect(readFileSync(w.installed(), "utf8")).toContain("ran:");
    expect(readdirNoTemp(w.prefix)).toEqual(["claude-rc"]);
  });

  test("--help style input is not treated as an installer option: only environment variables configure it", () => {
    const w = world();
    const r = w.run(["--version"]);
    expect(text(r.stdout)).toContain("ran: --version");
  });
});

function readdirNoTemp(dir: string): string[] {
  return require("node:fs").readdirSync(dir).filter((n: string) => !n.startsWith("."));
}
