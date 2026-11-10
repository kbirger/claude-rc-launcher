import { expect, test } from "bun:test";
import { Hono } from "hono";
import { closeStreams, sseResponse, stopServer, trackStreams } from "../src/sse";

test("stopServer ends an open stream with a proper end of body", async () => {
  const app = new Hono();
  trackStreams(app);
  app.get("/s", (c) => sseResponse(c, async (stream) => {
    await stream.writeSSE({ event: "hello", data: "1" });
    await new Promise(() => {}); // open until the server ends it
  }));
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const res = await fetch(`http://127.0.0.1:${server.port}/s`);
  const reader = res.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain("event: hello");
  stopServer(server, app);
  // A cut stream makes `read` throw; a clean end gives `done`.
  let done = false;
  while (!done) done = (await reader.read()).done;
  expect(done).toBe(true);
  server.stop(true);
});

test("stopServer on one app leaves the streams of another app open", async () => {
  const mk = () => {
    const app = new Hono();
    trackStreams(app);
    app.get("/s", (c) => sseResponse(c, async (stream) => {
      await stream.writeSSE({ data: "1" });
      await new Promise(() => {});
    }));
    return { app, server: Bun.serve({ port: 0, fetch: app.fetch }) };
  };
  const a = mk();
  const b = mk();
  const rb = (await fetch(`http://127.0.0.1:${b.server.port}/s`)).body!.getReader();
  await rb.read();
  closeStreams(a.app);
  const result = await Promise.race([rb.read().then(() => "ended"), Bun.sleep(200).then(() => "open")]);
  expect(result).toBe("open");
  a.server.stop(true);
  b.server.stop(true);
});
