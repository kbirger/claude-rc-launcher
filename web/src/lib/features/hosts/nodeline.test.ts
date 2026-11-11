import { expect, test } from "vitest";
import { versionsText } from "./nodeline";

test("a node shows its versions as reported, with the branch and commit of a local build", () => {
  expect(versionsText({ id: "a", name: "a", status: "ok", version: "0.12.4", clientVersion: "0.12.3" })).toBe("service 0.12.4, client 0.12.3");
  expect(versionsText({ id: "a", name: "a", status: "ok", version: "0.12.4+x.abc", clientVersion: "dev" })).toBe("service 0.12.4+x.abc, client dev");
});
