// Prints the tag of a test build. Usage: bun scripts/testbuild.ts <next-version> <branch> <sha>
// The tag is `v<next>-test.<branch slug>.<sha7>`. It is always a valid release tag and a test build for the version rules.

const MAX_SLUG = 30;

/** The branch name as dot separated letters and digits, at most 30 characters. An empty result gives `branch`. */
function slugOf(branch: string): string {
  const dotted = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
  const cut = dotted.slice(0, MAX_SLUG).replace(/\.+$/, "");
  return cut === "" ? "branch" : cut;
}

export function testBuildTag(next: string, branch: string, sha: string): string {
  const match = /^v?(\d+\.\d+\.\d+)$/.exec(next);
  if (!match) throw new Error(`the next version is not X.Y.Z: ${next}`);
  if (!/^[0-9a-fA-F]{7,}$/.test(sha)) throw new Error(`the sha is not at least 7 hex characters: ${sha}`);
  return `v${match[1]}-test.${slugOf(branch)}.${sha.slice(0, 7).toLowerCase()}`;
}

if (import.meta.main) {
  const [next = "", branch = "", sha = ""] = process.argv.slice(2);

  try {
    process.stdout.write(`${testBuildTag(next, branch, sha)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\nUsage: bun scripts/testbuild.ts <next-version> <branch> <sha>\n`,
    );
    process.exitCode = 1;
  }
}
