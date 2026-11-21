import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const script = path.resolve(import.meta.dir, "../../deploy/install-binary.sh");
const mode = (item: string) => statSync(item).mode & 0o777;

function run(args: string[], env: Record<string, string>) {
  const syncSubprocess = Bun.spawnSync(["bash", script, ...args], {
    env: { ...process.env, SKIP_SYSTEMCTL: "1", ...env },
  });
  return { code: syncSubprocess.exitCode, out: syncSubprocess.stdout.toString() + syncSubprocess.stderr.toString() };
}

function setup() {
  const file = mkdtempSync(path.join(os.tmpdir(), "rc-inst-"));
  const bin = path.join(file, "src-bin");
  // The script only checks for the ELF magic bytes and copies the file. A stub keeps each test fast: the Bun executable is over 100 MB.
  writeFileSync(bin, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from("stub\n")]), { mode: 0o755 });
  const env = {
    PREFIX: path.join(file, "prefix"),
    SYSTEMD_DIR: path.join(file, "systemd"),
    CONFIG_DIR: path.join(file, "etc"),
  };
  return { dir: file, bin, env };
}

describe.skipIf(process.platform === "win32")("install-binary.sh --service", () => {
  test("installs binary, unit with --config, config.toml and session.secret; blocks enabling", () => {
    const { bin, env } = setup();
    const outcome = run(["--service", bin], env);
    expect(outcome.code).toBe(0);
    const dest = path.join(env.PREFIX, "bin/claude-rc-launcher");
    expect(mode(dest)).toBe(0o755);
    const unit = readFileSync(path.join(env.SYSTEMD_DIR, "claude-rc-launcher.service"), "utf8");
    expect(unit).toContain(`ExecStart=${dest} --config ${env.CONFIG_DIR}/config.toml`);
    expect(unit).not.toContain("EnvironmentFile");
    expect(mode(path.join(env.CONFIG_DIR, "config.toml"))).toBe(0o644);
    expect(readFileSync(path.join(env.CONFIG_DIR, "config.toml"), "utf8")).toContain("example.com");
    const secret = path.join(env.CONFIG_DIR, "session.secret");
    expect(mode(secret)).toBe(0o600);
    expect(readFileSync(secret, "utf8").trim().length).toBeGreaterThanOrEqual(32);
    expect(outcome.out).toContain("Not enabling the service yet");
    expect(outcome.out).toContain("config.toml");
    expect(outcome.out).toContain("oidc-client.secret");
  });

  test("second run leaves config and secret byte-identical", () => {
    const { bin, env } = setup();
    run(["--service", bin], env);
    const files = ["config.toml", "session.secret"].map((item) => path.join(env.CONFIG_DIR, item));
    const before = files.map((file) => readFileSync(file, "utf8"));
    run(["--service", bin], env);
    expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(before);
  });

  test("a filled-in config and client secret lets it proceed", () => {
    const { bin, env } = setup();
    run(["--service", bin], env);
    writeFileSync(path.join(env.CONFIG_DIR, "config.toml"), 'public_url = "https://rc.mine.org"\n');
    writeFileSync(path.join(env.CONFIG_DIR, "oidc-client.secret"), "abc\n");
    const outcome = run(["--service", bin], env);
    expect(outcome.out).not.toContain("Not enabling");
    expect(existsSync(path.join(env.CONFIG_DIR, "session.secret"))).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("install-binary.sh --service --node", () => {
  test("installs the node config, no session.secret; unit has StateDirectory; placeholders block enabling", () => {
    const { bin, env } = setup();
    const outcome = run(["--service", "--node", bin], env);
    expect(outcome.code).toBe(0);
    const conf = readFileSync(path.join(env.CONFIG_DIR, "config.toml"), "utf8");
    expect(conf).toContain('mode = "node"');
    expect(conf).toContain("[tls]");
    expect(existsSync(path.join(env.CONFIG_DIR, "session.secret"))).toBe(false);
    const unit = readFileSync(path.join(env.SYSTEMD_DIR, "claude-rc-launcher.service"), "utf8");
    expect(unit).toContain("StateDirectory=claude-rc-launcher");
    expect(outcome.out).toContain("Not enabling the service yet");
    expect(outcome.out).toContain("node-cert.pem");
    expect(outcome.out).toContain("fingerprint");
  });

  test("second run leaves the config byte-identical", () => {
    const { bin, env } = setup();
    run(["--service", "--node", bin], env);
    const file = path.join(env.CONFIG_DIR, "config.toml");
    const before = readFileSync(file, "utf8");
    run(["--service", "--node", bin], env);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("a filled-in config with a node_auth method lets it proceed; none does not", () => {
    const { bin, env } = setup();
    run(["--service", "--node", bin], env);
    const file = path.join(env.CONFIG_DIR, "config.toml");
    const head = ['mode = "node"', "[tls]", 'names = ["pi.internal"]'];
    writeFileSync(file, head.join("\n") + "\n");
    expect(run(["--service", "--node", bin], env).out).toContain("node_auth");
    writeFileSync(file, [...head, "[[node_auth.secret]]", `sha256 = "${"a".repeat(64)}"`].join("\n") + "\n");
    const outcome = run(["--service", "--node", bin], env);
    expect(outcome.out).not.toContain("Not enabling");
  });

  test("a node file with a hub_key row lets it proceed; only node_auth.oidc does not", () => {
    const { bin, env } = setup();
    run(["--service", "--node", bin], env);
    const file = path.join(env.CONFIG_DIR, "config.toml");
    const head = ['mode = "node"', "[tls]", 'names = ["pi.internal"]'];
    writeFileSync(file, [...head, "[node_auth.oidc]", 'issuer = "https://idp"'].join("\n") + "\n");
    expect(run(["--service", "--node", bin], env).out).toContain("node_auth");
    writeFileSync(
      file,
      [...head, "[[node_auth.hub_key]]", `public_key = "${Buffer.alloc(32, 1).toString("base64url")}"`].join("\n") +
        "\n",
    );
    const outcome = run(["--service", "--node", bin], env);
    expect(outcome.out).not.toContain("Not enabling");
  });
});
