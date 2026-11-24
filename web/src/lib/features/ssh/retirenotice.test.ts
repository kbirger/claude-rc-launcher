import { expect, test } from "vitest";
import type { RetireResult } from "./api";
import { retireNotice } from "./retirenotice";

const base: RetireResult = {
  id: "nas",
  account: "admin",
  address: "10.0.0.5",
  port: 22,
  systemType: "linux",
  managed: true,
  line: "failed",
};

test("retireNotice drops a trailing period of the detail, so that no sentence ends with two periods", () => {
  for (const detail of ["connect refused.", "connect refused...", "connect refused. ", "connect refused"]) {
    const text = retireNotice({ ...base, detail });
    expect(text).toContain("from admin@10.0.0.5: connect refused. You can remove");
    expect(text).not.toContain("..");
  }
});

test("retireNotice has a text for a failed result without a detail", () => {
  expect(retireNotice(base)).toContain("the removal failed. You can remove");
});
