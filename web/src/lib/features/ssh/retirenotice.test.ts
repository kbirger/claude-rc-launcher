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

const COMMENTS = ["claude-rc:nas", "claude-rc-provisioner:nas"];

test("the retire notice names both comments after a failed uninstall", () => {
  const text = retireNotice({
    ...base,
    managed: false,
    comments: COMMENTS,
    script: "/home/admin/p-nas.sh",
    detail: "run failed",
  });
  expect(text).toContain("claude-rc:nas and claude-rc-provisioner:nas");
  expect(text).toContain("/home/admin/p-nas.sh");
  expect(text).toContain("They no longer work.");
});

test("the retire notice does not repeat the lines that the detail names", () => {
  const detail = `run failed. The key lines stay on the machine: remove the lines that end with ${COMPS()}`;
  const text = retireNotice({ ...base, managed: false, comments: COMMENTS, detail });
  expect(text.match(/claude-rc-provisioner:nas/g)).toHaveLength(1);
});

function COMPS() {
  return "claude-rc:nas and claude-rc-provisioner:nas";
}

test("the retire notice for a retire without cleanup names both comments", () => {
  const text = retireNotice({ ...base, managed: false, line: "manual", comments: COMMENTS });
  expect(text).toContain("The hub did not clean up the machine.");
  expect(text).toContain("claude-rc:nas and claude-rc-provisioner:nas");
});
