import { expect, test } from "bun:test";
import { clientLabel } from "./clientlabel";

test("shows the client version", () => expect(clientLabel({ clientVersion: "0.8.4" })).toBe("0.8.4"));
test("says no client when the machine has none", () => expect(clientLabel({ noClient: true })).toBe("no client"));
test("says not reported when nothing is known", () => expect(clientLabel({})).toBe("client not reported"));
test("prefers the version over noClient", () => expect(clientLabel({ clientVersion: "0.8.4", noClient: true })).toBe("0.8.4"));
