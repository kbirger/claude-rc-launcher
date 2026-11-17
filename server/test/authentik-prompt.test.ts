import { describe, expect, test } from "bun:test";
import { askSettings, type Io } from "../../scripts/authentik/prompt";
import { parseSettings } from "../../scripts/authentik/settings";

const env = { AUTHENTIK_URL: "https://auth.example.com", AUTHENTIK_TOKEN: "t" };
const scripted = (answers: string[], tty = true): Io & { asked: string[] } => {
  const asked: string[] = [];
  return { tty, asked, ask: async (q: string) => {
      asked.push(q);
      if (asked.length > 30) throw new Error("too many questions");
      return answers.shift() ?? "";
    } };
};

describe("askSettings", () => {
  test("empty answers keep every default, but the public url has none and is asked again", async () => {
    const base = parseSettings(["--interactive"], env);
    const io = scripted(["", "https://rc.example.com"]);
    const r = await askSettings(base, io);
    expect(r.publicUrl).toBe("https://rc.example.com");
    expect(r.settings).toEqual({ ...base.settings });
  });
  test("an answer replaces the value and the default shows in the question", async () => {
    const base = parseSettings(["--interactive", "--public-url", "https://rc.example.com"], env);
    const io = scripted(["", "my-web", "", "", "my_claim", "", "kir"]);
    const r = await askSettings(base, io);
    expect(r.settings.webApp.slug).toBe("my-web");
    expect(r.settings.claim).toBe("my_claim");
    expect(r.settings.adminUser).toBe("kir");
    expect(io.asked[0]).toContain("[https://rc.example.com]");
    expect(io.asked[1]).toContain("[claude-rc-launcher]");
  });
  test("an invalid answer repeats the question with the reason", async () => {
    const base = parseSettings(["--interactive", "--public-url", "https://rc.example.com"], env);
    const io = scripted(["", "Bad Slug", "good-slug"]);
    const r = await askSettings(base, io);
    expect(r.settings.webApp.slug).toBe("good-slug");
    expect(io.asked[2]).toContain("a slug has only");
  });
  test("without a terminal it refuses", async () => {
    const base = parseSettings(["--interactive", "--public-url", "https://rc.example.com"], env);
    await expect(askSettings(base, scripted([], false))).rejects.toThrow(/needs a terminal/);
  });
  test("a group prefix answer renames the groups", async () => {
    const base = parseSettings(["--interactive", "--public-url", "https://rc.example.com"], env);
    const r = await askSettings(base, scripted(["", "", "", "team"]));
    expect(r.settings.groups.map((g) => g.name)).toEqual(["team-admins", "team-writers", "team-ro"]);
  });
});
