import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, Config, serverUrl, display } from "../src/client.mjs";

test("credentials are saved privately and reloaded without leaking to other origins", async () => {
  const home = await mkdtemp(join(tmpdir(), "tokenhub-client-test-"));
  try {
    const config = await new Config(home).load();
    config.data = { server: "https://tokenhub.example", token: "secret" };
    await config.save();
    assert.deepEqual((await new Config(home).load()).data, config.data);
    if (process.platform !== "win32")
      assert.equal((await stat(config.file)).mode & 0o777, 0o600);
    let request;
    const client = new Client(config, async (url, options) => {
      request = { url, options };
      return new Response('{"ok":true}');
    });
    await client.request("/me");
    assert.equal(request.url, "https://tokenhub.example/api/me");
    assert.equal(request.options.headers.Authorization, "Bearer secret");
    assert.equal(request.options.redirect, "error");
    await client.request(
      "/cli/login",
      { email: "a@b.com", password: "password" },
      { anonymous: true },
    );
    assert.equal(request.options.headers.Authorization, undefined);
    assert.equal(
      (await readFile(config.file, "utf8")).includes("password"),
      false,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("server validation rejects insecure remote origins and ambiguous URLs", () => {
  for (const url of [
    "http://example.com",
    "ftp://localhost",
    "https://a:b@example.com",
    "https://example.com/api",
    "https://example.com?secret=x",
  ])
    assert.throws(() => serverUrl(url));
  assert.equal(serverUrl("http://localhost:3000"), "http://localhost:3000");
  assert.equal(serverUrl("https://example.com/"), "https://example.com");
});
test("API failures are not retried and preserve status for session handling", async () => {
  let calls = 0;
  const client = new Client(
    { data: { server: "https://example.com", token: "secret" } },
    async () => {
      calls++;
      return new Response('{"error":"Pass exhausted"}', { status: 409 });
    },
  );
  await assert.rejects(
    client.request("/conversations/id/messages", { content: "hi" }),
    { status: 409, message: "Pass exhausted" },
  );
  assert.equal(calls, 1);
});
test("remote text cannot emit terminal control sequences", () => {
  assert.equal(
    display("\x1b[31mhello\x1b[0m\x1b]52;c;secret\x07\r!"),
    "hello!",
  );
});
