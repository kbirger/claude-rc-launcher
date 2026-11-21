import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.join(import.meta.dir, "../../install-cli.sh");
const sha = (item: string) => createHash("sha256").update(item).digest("hex");
const REL = "https://github.com/kbirger/claude-rc-launcher/releases";

/** A directory of fake `curl`, `uname` and `sudo`, and a fake release to download from. */
function world(
  options: { os?: string; arch?: string; sums?: (asset: string, body: string) => string; assets?: string[] } = {},
) {
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

  for (const asset of options.assets ?? [
    "claude-rc-linux-x64",
    "claude-rc-linux-arm64",
    "claude-rc-darwin-x64",
    "claude-rc-darwin-arm64",
  ]) {
    writeFileSync(path.join(release, asset), body);
  }

  const sums = (
    options.assets ?? ["claude-rc-linux-x64", "claude-rc-linux-arm64", "claude-rc-darwin-x64", "claude-rc-darwin-arm64"]
  )
    .map((entry) => (options.sums ? options.sums(entry, body) : `${sha(body)}  ${entry}`))
    .join("\n");
  writeFileSync(path.join(release, "SHA256SUMS"), sums + "\n");

  const sh = (name: string, text: string) => {
    writeFileSync(path.join(shims, name), `#!/bin/sh\n${text}\n`);
    chmodSync(path.join(shims, name), 0o755);
  };

  // curl -fsSL -o <file> <url>: copies release/<basename of url> and records the url.
  sh(
    "curl",
    `echo "$@" >> ${log}\nout=""; url=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; -*) shift;; *) url="$1"; shift;; esac; done\nf="${release}/$(basename "$url")"\n[ -f "$f" ] || { echo "curl: (22) 404 $url" >&2; exit 22; }\ncp "$f" "$out"`,
  );
  sh("uname", `case "$1" in -s) echo "${options.os ?? "Linux"}";; -m) echo "${options.arch ?? "x86_64"}";; esac`);
  // `id -u` answers FAKE_UID when set, so a test can act as root or as a normal user whatever user runs the tests.
  sh("id", `[ "$1" = -u ] && [ -n "\${FAKE_UID:-}" ] && { echo "$FAKE_UID"; exit 0; }\nexec /usr/bin/id "$@"`);
  sh("sudo", `echo "sudo $*" >> ${log}\nexec "$@"`);
  const registry = path.join(dir, "registry"); // stands in for /etc/claude-rc-launcher; no test touches the real one
  const run = (args: string[] = [], env: Record<string, string> = {}, cwd?: string) =>
    Bun.spawnSync(["sh", SCRIPT, ...args], {
      env: {
        PATH: `${shims}:/usr/bin:/bin`,
        HOME: dir,
        CLAUDE_RC_PREFIX: prefix,
        CLAUDE_RC_REGISTRY_DIR: registry,
        ...env,
      },
      stdin: null,
      cwd,
    });
  return {
    dir,
    prefix,
    registry,
    run,
    urls: () => readFileSync(log, "utf8"),
    installed: () => path.join(prefix, "claude-rc"),
  };
}

const text = (item: Uint8Array | undefined) => new TextDecoder().decode(item ?? new Uint8Array());

describe("install-cli.sh", () => {
  test("installs the CLI for Linux x64 from the latest release, mode 755, and checks it against SHA256SUMS", () => {
    const harness = world();
    const syncSubprocess = harness.run();
    expect(syncSubprocess.exitCode).toBe(0);
    expect(existsSync(harness.installed())).toBe(true);
    if (process.platform !== "win32") expect(statSync(harness.installed()).mode & 0o777).toBe(0o755);
    expect(readFileSync(harness.installed(), "utf8")).toContain("ran:");
    expect(harness.urls()).toContain(`${REL}/latest/download/claude-rc-linux-x64`);
    expect(harness.urls()).toContain(`${REL}/latest/download/SHA256SUMS`);
    expect(text(syncSubprocess.stdout)).toContain(harness.installed());
  });

  test("maps the CPU and the OS: arm64, aarch64, macOS", () => {
    for (const [uos, arch, asset] of [
      ["Linux", "aarch64", "claude-rc-linux-arm64"],
      ["Linux", "arm64", "claude-rc-linux-arm64"],
      ["Darwin", "arm64", "claude-rc-darwin-arm64"],
      ["Darwin", "x86_64", "claude-rc-darwin-x64"],
      ["Linux", "amd64", "claude-rc-linux-x64"],
    ] as const) {
      const harness = world({ os: uos, arch });
      expect([uos, arch, harness.run().exitCode]).toEqual([uos, arch, 0]);
      expect(harness.urls()).toContain(`/latest/download/${asset}`);
    }
  });

  test("an unsupported OS or CPU stops before downloading anything", () => {
    for (const [uos, arch, msg] of [
      ["FreeBSD", "x86_64", "FreeBSD"],
      ["MINGW64_NT-10.0", "x86_64", "Windows"],
      ["Linux", "riscv64", "riscv64"],
    ] as const) {
      const harness = world({ os: uos, arch });
      const syncSubprocess = harness.run();
      expect([uos, syncSubprocess.exitCode === 0]).toEqual([uos, false]);
      expect(text(syncSubprocess.stderr)).toContain(msg);
      expect(harness.urls()).toBe("");
      expect(existsSync(harness.installed())).toBe(false);
    }
  });

  test("a checksum mismatch installs nothing and says so", () => {
    const harness = world({ sums: (entry) => `${"1".repeat(64)}  ${entry}` });
    const syncSubprocess = harness.run();
    expect(syncSubprocess.exitCode).not.toBe(0);
    expect(text(syncSubprocess.stderr)).toContain("checksum");
    expect(existsSync(harness.installed())).toBe(false);
  });

  test("a SHA256SUMS without the asset installs nothing", () => {
    const harness = world({ sums: (entry) => `${sha("x")}  other-${entry}` });
    const syncSubprocess = harness.run();
    expect(syncSubprocess.exitCode).not.toBe(0);
    expect(existsSync(harness.installed())).toBe(false);
  });

  test("a missing release asset stops with the URL", () => {
    const harness = world({ assets: [] });
    const syncSubprocess = harness.run();
    expect(syncSubprocess.exitCode).not.toBe(0);
    expect(text(syncSubprocess.stderr)).toContain("claude-rc-linux-x64");
  });

  test("CLAUDE_RC_VERSION picks that release", () => {
    const harness = world();
    expect(harness.run([], { CLAUDE_RC_VERSION: "v0.2.0" }).exitCode).toBe(0);
    expect(harness.urls()).toContain(`${REL}/download/v0.2.0/claude-rc-linux-x64`);
  });

  test("arguments after the script are passed to claude-rc, and its exit code is returned", () => {
    const harness = world();
    const syncSubprocess = harness.run(["node", "setup", "--hub", "https://rc.example.com", "--listen", "10.0.0.5"]);
    expect(syncSubprocess.exitCode).toBe(0);
    expect(text(syncSubprocess.stdout)).toContain("ran: node setup --hub https://rc.example.com --listen 10.0.0.5");
    const bad = harness.run(["whoami"], { FAKE_EXIT: "2" });
    expect(bad.exitCode).toBe(2);
  });

  test("the install is replaced atomically: a running old copy is not overwritten in place", () => {
    const harness = world();
    mkdirSync(harness.prefix, { recursive: true });
    writeFileSync(harness.installed(), "old");
    expect(harness.run().exitCode).toBe(0);
    expect(readFileSync(harness.installed(), "utf8")).toContain("ran:");
    expect(readdirNoTemp(harness.prefix)).toEqual(["claude-rc"]);
  });

  test("--help style input is not treated as an installer option: only environment variables configure it", () => {
    const harness = world();
    const syncSubprocess = harness.run(["--version"]);
    expect(text(syncSubprocess.stdout)).toContain("ran: --version");
  });
});

describe("install-cli.sh: the client registry", () => {
  const mode = (item: string) => statSync(item).mode & 0o777;
  const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean);

  test("an install with root rights writes `client <path>` to a new registry: file 0644, directory 0755", () => {
    const harness = world();
    const syncSubprocess = harness.run([], { FAKE_UID: "0" });
    expect(syncSubprocess.exitCode).toBe(0);
    const file = path.join(harness.registry, "installs");
    expect(lines(file)).toEqual([`client ${harness.installed()}`]);
    expect(mode(file)).toBe(0o644);
    expect(mode(harness.registry)).toBe(0o755);
  });

  test("a second run adds no second line", () => {
    const harness = world();
    expect(harness.run([], { FAKE_UID: "0" }).exitCode).toBe(0);
    expect(harness.run([], { FAKE_UID: "0" }).exitCode).toBe(0);
    expect(lines(path.join(harness.registry, "installs"))).toEqual([`client ${harness.installed()}`]);
  });

  test("an existing registry directory keeps its mode, an existing file keeps its other lines and its mode", () => {
    const harness = world();
    mkdirSync(harness.registry, { mode: 0o750 });
    chmodSync(harness.registry, 0o750);
    const file = path.join(harness.registry, "installs");
    writeFileSync(file, "client /opt/other/claude-rc"); // no final newline
    chmodSync(file, 0o600);
    expect(harness.run([], { FAKE_UID: "0" }).exitCode).toBe(0);
    expect(mode(harness.registry)).toBe(0o750);
    expect(mode(file)).toBe(0o600);
    expect(lines(file)).toEqual(["client /opt/other/claude-rc", `client ${harness.installed()}`]);
  });

  test("a relative CLAUDE_RC_PREFIX is written as an absolute path", () => {
    const harness = world();
    const syncSubprocess = harness.run([], { FAKE_UID: "0", CLAUDE_RC_PREFIX: "rel-bin" }, harness.dir); // runs in the test's own directory
    expect(syncSubprocess.exitCode).toBe(0);
    expect(lines(path.join(harness.registry, "installs"))).toEqual([
      `client ${path.join(harness.dir, "rel-bin")}/claude-rc`,
    ]);
  });

  test("an existing root-only registry directory and its file are not changed: mode and content stay", () => {
    const harness = world();
    mkdirSync(harness.registry, { mode: 0o750 });
    chmodSync(harness.registry, 0o750);
    const file = path.join(harness.registry, "installs");
    writeFileSync(file, `client ${harness.installed()}\n`); // already registered
    chmodSync(file, 0o640);
    const before = readFileSync(file, "utf8");
    expect(harness.run([], { FAKE_UID: "0" }).exitCode).toBe(0);
    expect([mode(harness.registry), mode(file), readFileSync(file, "utf8")]).toEqual([0o750, 0o640, before]);
  });

  test("an install in a user's own directory without root rights writes nothing", () => {
    const harness = world();
    const syncSubprocess = harness.run([], { FAKE_UID: "1000" });
    expect(syncSubprocess.exitCode).toBe(0);
    expect(existsSync(harness.registry)).toBe(false);
    expect(harness.urls()).not.toContain("sudo");
  });

  test("a registry that cannot be written is a warning, and the install still succeeds", () => {
    const harness = world();
    writeFileSync(path.join(harness.dir, "afile"), "x");
    const syncSubprocess = harness.run([], {
      FAKE_UID: "0",
      CLAUDE_RC_REGISTRY_DIR: path.join(harness.dir, "afile", "sub"),
    });
    expect(syncSubprocess.exitCode).toBe(0);
    expect(existsSync(harness.installed())).toBe(true);
    expect(text(syncSubprocess.stderr)).toContain("warning");
    expect(text(syncSubprocess.stderr)).toContain("installs");
  });

  test("an install that uses sudo writes the registry through sudo: file 0644, one line, directory 0755", () => {
    const harness = world();
    // CLAUDE_RC_FORCE_SUDO is a test hook: it takes the SUDO=sudo branch although the prefix is writable (as it is for
    // root, and for the test user), so this works for any user. The fake sudo logs each command and then runs it.
    const syncSubprocess = harness.run([], { FAKE_UID: "1000", CLAUDE_RC_FORCE_SUDO: "1" });
    expect(syncSubprocess.exitCode).toBe(0);
    const file = path.join(harness.registry, "installs");
    const log = harness.urls();

    for (const cmd of [
      `sudo mkdir -p ${harness.registry}`,
      `sudo chmod 755 ${harness.registry}`,
      `sudo test -d ${harness.registry}`,
      `sudo test -e ${file}`,
      `sudo install -m 644 /dev/null ${file}`,
      `sudo grep -Fxq client ${harness.installed()} ${file}`,
      `sudo tee -a ${file}`,
    ]) {
      expect(log).toContain(cmd);
    }

    expect(lines(file)).toEqual([`client ${harness.installed()}`]);
    expect(mode(file)).toBe(0o644);
    expect(mode(harness.registry)).toBe(0o755);
  });
});

function readdirNoTemp(dir: string): string[] {
  return require("node:fs")
    .readdirSync(dir)
    .filter((item: string) => !item.startsWith("."));
}
