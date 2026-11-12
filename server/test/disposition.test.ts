import { describe, expect, test } from "bun:test";
import { dispositionFor, downloadHeaders, lastSegment } from "../src/disposition";

describe("disposition", () => {
  test("dispositionFor gives an ASCII fallback and the exact UTF-8 name", () => {
    expect(dispositionFor(`a"b\\c\r\n.txt`)).toBe(`attachment; filename="abc.txt"; filename*=UTF-8''a%22b%5Cc%0D%0A.txt`);
    expect(dispositionFor("it's (1)*.txt")).toBe(`attachment; filename="it's (1)*.txt"; filename*=UTF-8''it%27s%20%281%29%2A.txt`);
  });
  test("lastSegment takes the last name of a path", () => {
    expect(lastSegment("a/b/c.txt")).toBe("c.txt");
    expect(lastSegment("a\\b\\c.txt")).toBe("c.txt");
    expect(lastSegment("c.txt/")).toBe("c.txt");
    expect(lastSegment("")).toBe("download");
    expect(lastSegment("a/..")).toBe("a");
  });
  test("downloadHeaders are safe and carry the size when known", () => {
    const h = downloadHeaders("x.html", 3);
    expect(h.get("content-type")).toBe("application/octet-stream");
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(h.get("content-length")).toBe("3");
    expect(downloadHeaders("x").get("content-length")).toBeNull();
  });
});
