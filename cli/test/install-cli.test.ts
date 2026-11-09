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
  // `id -u` answers FAKE_UID when set, so a test can act as root or as a normal user whatever user runs the tests.
  sh("id", `[ "$1" = -u ] && [ -n "\${FAKE_UID:-}" ] && { echo "$FAKE_UID"; exit 0; }\nexec /usr/bin/id "$@"`);
  sh("sudo", `echo "sudo $*" >> ${log}\nexec "$@"`);
  const registry = path.join(dir, "registry"); // stands in for /etc/claude-rc-launcher; no test touches the real one
  const run = (args: string[] = [], env: Record<string, string> = {}) =>
    Bun.spawnSync(["sh", SCRIPT, ...args], { env: { PATH: `${shims}:/usr/bin:/bin`, HOME: dir, CLAUDE_RC_PREFIX: prefix, CLAUDE_RC_REGISTRY_DIR: registry, ...env }, stdin: null });
  return { dir, prefix, registry, run, urls: () => readFileSync(log, "utf8"), installed: () => path.join(prefix, "claude-rc") };
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

describe("install-cli.sh: the client registry", () => {
  const mode = (p: string) => statSync(p).mode & 0o777;
  const lines = (p: string) => readFileSync(p, "utf8").split("\n").filter(Boolean);

  test("an install with root rights writes `client <path>` to a new registry: file 0644, directory 0755", () => {
    const w = world();
    const r = w.run([], { FAKE_UID: "0" });
    expect(r.exitCode).toBe(0);
    const file = path.join(w.registry, "installs");
    expect(lines(file)).toEqual([`client ${w.installed()}`]);
    expect(mode(file)).toBe(0o644);
    expect(mode(w.registry)).toBe(0o755);
  });

  test("a second run adds no second line", () => {
    const w = world();
    expect(w.run([], { FAKE_UID: "0" }).exitCode).toBe(0);
    expect(w.run([], { FAKE_UID: "0" }).exitCode).toBe(0);
    expect(lines(path.join(w.registry, "installs"))).toEqual([`client ${w.installed()}`]);
  });

  test("an existing registry directory keeps its mode, an existing file keeps its other lines and its mode", () => {
    const w = world();
    mkdirSync(w.registry, { mode: 0o750 });
    chmodSync(w.registry, 0o750);
    const file = path.join(w.registry, "installs");
    writeFileSync(file, "client /opt/other/claude-rc"); // no final newline
    chmodSync(file, 0o600);
    expect(w.run([], { FAKE_UID: "0" }).exitCode).toBe(0);
    expect(mode(w.registry)).toBe(0o750);
    expect(mode(file)).toBe(0o600);
    expect(lines(file)).toEqual(["client /opt/other/claude-rc", `client ${w.installed()}`]);
  });

  test("a relative CLAUDE_RC_PREFIX is written as an absolute path", () => {
    const w = world();
    const rel = `rel-bin-${process.pid}`;
    try {
      const r = w.run([], { FAKE_UID: "0", CLAUDE_RC_PREFIX: rel });
      expect(r.exitCode).toBe(0);
      expect(lines(path.join(w.registry, "installs"))).toEqual([`client ${path.resolve(rel)}/claude-rc`]);
    } finally {
      require("node:fs").rmSync(path.resolve(rel), { recursive: true, force: true });
    }
  });

  test("an existing root-only registry directory and its file are not changed: mode and content stay", () => {
    const w = world();
    mkdirSync(w.registry, { mode: 0o750 });
    chmodSync(w.registry, 0o750);
    const file = path.join(w.registry, "installs");
    writeFileSync(file, `client ${w.installed()}\n`); // already registered
    chmodSync(file, 0o640);
    const before = readFileSync(file, "utf8");
    expect(w.run([], { FAKE_UID: "0" }).exitCode).toBe(0);
    expect([mode(w.registry), mode(file), readFileSync(file, "utf8")]).toEqual([0o750, 0o640, before]);
  });

  test("an install in a user's own directory without root rights writes nothing", () => {
    const w = world();
    const r = w.run([], { FAKE_UID: "1000" });
    expect(r.exitCode).toBe(0);
    expect(existsSync(w.registry)).toBe(false);
    expect(w.urls()).not.toContain("sudo");
  });

  test("a registry that cannot be written is a warning, and the install still succeeds", () => {
    const w = world();
    writeFileSync(path.join(w.dir, "afile"), "x");
    const r = w.run([], { FAKE_UID: "0", CLAUDE_RC_REGISTRY_DIR: path.join(w.dir, "afile", "sub") });
    expect(r.exitCode).toBe(0);
    expect(existsSync(w.installed())).toBe(true);
    expect(text(r.stderr)).toContain("warning");
    expect(text(r.stderr)).toContain("installs");
  });

  // `[ -w dir ]` is always true for root, so a real sudo install can only be made by a normal user: skipped when root.
  test.skipIf(process.getuid?.() === 0)("an install that needs sudo writes the registry through sudo, with the right modes", () => {
    const w = world();
    mkdirSync(w.prefix, { mode: 0o555 });
    chmodSync(w.prefix, 0o555);
    try {
      // The fake sudo runs the command as the same user, so the unwritable prefix fails the install itself; the logged
      // calls of the registry step are still checked on a second, writable prefix with FAKE_UID=0 below.
      expect(w.run([], { FAKE_UID: "1000" }).exitCode).toBe(0);
    } finally { chmodSync(w.prefix, 0o755); }
    expect(w.urls()).toContain("sudo install -m 755");
  });

  test("the registry commands are the ones that need root, and the files end with the right modes", () => {
    const w = world();
    // As root the script needs no sudo; a stand-in `sudo` is put in front by SUDO-less runs only for the log, so here
    // the modes are the evidence, and the commands are checked in the script text.
    expect(w.run([], { FAKE_UID: "0" }).exitCode).toBe(0);
    expect(mode(path.join(w.registry, "installs"))).toBe(0o644);
    expect(mode(w.registry)).toBe(0o755);
    const src = readFileSync(SCRIPT, "utf8");
    for (const cmd of ['$SUDO mkdir -p "$REGISTRY_DIR"', '$SUDO chmod 755 "$REGISTRY_DIR"', '$SUDO install -m 644 /dev/null "$rfile"', '$SUDO tee -a "$rfile"', '$SUDO test -d "$REGISTRY_DIR"', '$SUDO test -e "$rfile"', '$SUDO grep -Fxq']) {
      expect(src).toContain(cmd);
    }
  });
});

function readdirNoTemp(dir: string): string[] {
  return require("node:fs").readdirSync(dir).filter((n: string) => !n.startsWith("."));
}
