import { afterEach, beforeEach, vi } from "vitest";

export type FetchCall = { url: string; init?: RequestInit };

// Replaces `fetch` and `location` for every test of the calling file and puts the originals back afterwards.
// `stub(status, body)` answers each request with a JSON body and `calls` records the requests.
export function useFetchStub() {
  const calls: FetchCall[] = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal("location", { href: "/" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stub(status: number, body: unknown) {
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    });
  }

  return { calls, stub };
}
