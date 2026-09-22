import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "./database.js";
import { once } from "node:events";
import type { Server } from "node:http";
import { createApp } from "../src/app.js";
import { migrate, type Database } from "../src/db.js";
import { vault } from "../src/security.js";
import { cliArgs, safeEnv, type Provider } from "../src/provider.js";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let db: Database;
let server: Server;
let base: string;
let close: () => Promise<void>;
let calls = 0;
let mode: "normal" | "slow" | "fail" = "normal";
let resolveStarted: () => void = () => {};
const fake: Provider = {
  async run(_credential, messages, signal, _saveCredential, conversationMode) {
    calls++;
    resolveStarted();
    if (mode === "fail") throw new Error("Provider disconnected");
    if (mode === "slow")
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 1000);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("cancelled"));
          },
          { once: true },
        );
      });
    const text =
      conversationMode === "agent"
        ? JSON.stringify(
            messages.at(-1)!.content.startsWith("Local tool result")
              ? {
                  type: "message",
                  content:
                    "Inspected local project: " + messages.at(-1)!.content,
                }
              : { type: "tool", name: "read", path: "example.txt" },
          )
        : "Reply: " + messages.at(-1)!.content;
    return { text, tokens: 200 };
  },
};
let lender: { cookie: string; id: string };
let borrower: { cookie: string; id: string };
let stranger: { cookie: string; id: string };
const origin = "http://localhost:3000";
async function request(
  cookie: string,
  path: string,
  body?: unknown,
  method?: string,
) {
  const response = await fetch(base + path, {
    method: method || (body ? "POST" : "GET"),
    headers: {
      origin,
      cookie,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
  };
}
async function register(name: string) {
  const r = await request("", "/auth/register", {
    name,
    email: name + "@example.com",
    password: "A-safe-password-123",
  });
  assert.equal(r.status, 201);
  return { cookie: r.cookie, id: r.data.user.id };
}
before(async () => {
  db = await createTestDatabase();
  await migrate(db);
  const built = createApp({
    db,
    provider: fake,
    encryptionKey: "11".repeat(32),
    origin,
    demo: true,
  });
  close = built.close;
  server = built.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = "http://127.0.0.1:" + (server.address() as any).port + "/api";
  lender = await register("Lender");
  borrower = await register("Borrower");
  stranger = await register("Stranger");
  assert.equal((await request(lender.cookie, "/connection", {})).status, 200);
});
beforeEach(async () => {
  await db.query("DELETE FROM rate_limits");
});
after(async () => {
  await close();
  server.close();
  await once(server, "close");
  await db.close();
});
async function offer() {
  const r = await request(lender.cookie, "/offers", {
    title: "TypeScript help",
    description: "Build something useful",
    tokenLimit: 1000,
    durationMinutes: 60,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id as string;
}
async function approved(limit = 1000) {
  const id = await offer();
  const r = await request(borrower.cookie, "/offers/" + id + "/request", {
    note: "Learning TypeScript",
  });
  assert.equal(r.status, 201);
  const grantId = r.data.id;
  const a = await request(lender.cookie, "/grants/" + grantId + "/approve", {
    tokenLimit: limit,
    durationMinutes: 30,
  });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  const code = (await request(borrower.cookie, "/grants/" + grantId + "/code"))
    .data.code;
  return { grantId, code, offerId: id };
}
async function active(limit = 1000) {
  const g = await approved(limit);
  assert.equal(
    (await request(borrower.cookie, "/redeem", { code: g.code })).status,
    200,
  );
  const c = await request(borrower.cookie, "/conversations", {
    grantId: g.grantId,
  });
  assert.equal(c.status, 201);
  return { ...g, conversationId: c.data.id };
}

test("CLI sessions are scoped, account-bound, revocable and share token accounting", async () => {
  const g = await active(200);
  const login = await fetch(base + "/cli/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "borrower@example.com",
      password: "A-safe-password-123",
    }),
  });
  assert.equal(login.status, 200);
  assert.equal(login.headers.get("set-cookie"), null);
  const credentials = await login.json();
  assert.equal(
    (
      await db.query("SELECT hash FROM cli_sessions WHERE user_id=$1", [
        borrower.id,
      ])
    ).rows.some((r) => r.hash === credentials.token),
    false,
  );
  const cli = async (
    path: string,
    body?: unknown,
    token = credentials.token,
  ) => {
    const r = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };
  assert.equal((await cli("/connection", {})).status, 403);
  assert.equal((await cli("/lending")).status, 403);
  assert.equal(
    (await request("tokenhub_session=" + credentials.token, "/me")).status,
    401,
  );
  assert.equal(
    (await cli("/me", undefined, borrower.cookie.split("=")[1])).status,
    401,
  );
  const reply = await cli(`/conversations/${g.conversationId}/messages`, {
    content: "CLI test",
  });
  assert.equal(reply.status, 200);
  const usage = (await cli("/cli/usage")).data;
  assert.ok(
    usage.grants.every((grant: any) => grant.borrower_id === borrower.id),
  );
  const used = usage.grants.find((grant: any) => grant.id === g.grantId);
  assert.equal(used.remaining_tokens, 0);
  assert.equal(used.effective_status, "exhausted");
  assert.ok(
    usage.events.some(
      (event: any) => event.grant_id === g.grantId && event.tokens === 200,
    ),
  );
  assert.equal(
    (
      await cli(`/conversations/${g.conversationId}/messages`, {
        content: "blocked",
      })
    ).status,
    409,
  );
  assert.equal((await cli("/cli/logout", {})).status, 200);
  assert.equal((await cli("/me")).status, 401);
});
test("installed CLI entrypoint logs in, runs local agent tools, resumes chat and reports usage", async () => {
  const grant = await active(1000);
  const home = await mkdtemp(join(tmpdir(), "tokenhub-cli-integration-"));
  await writeFile(join(home, "example.txt"), "fixture project content");
  const run = (args: string[]) =>
    new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("../../cli/bin/tokenhub.mjs", import.meta.url)),
          ...args,
        ],
        {
          cwd: home,
          windowsHide: true,
          env: {
            ...process.env,
            TOKENHUB_HOME: join(home, ".tokenhub"),
            TOKENHUB_PASSWORD: "A-safe-password-123",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      const timer = setTimeout(() => child.kill(), 15000);
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    });
  try {
    assert.equal(
      (
        await run([
          "login",
          "--server",
          base.replace(/\/api$/, ""),
          "--email",
          "borrower@example.com",
        ])
      ).code,
      0,
    );
    assert.equal((await run(["use", grant.grantId])).code, 0);
    const agent = await run(["agent", "Inspect my project"]);
    assert.equal(agent.code, 0, agent.output);
    assert.match(agent.output, /fixture project content/);
    let usage = JSON.parse((await run(["usage", "--json"])).output);
    assert.equal(
      usage.grants.find((g: any) => g.id === grant.grantId).used_tokens,
      400,
    );
    const state = JSON.parse(
      await readFile(join(home, ".tokenhub", "config.json"), "utf8"),
    );
    assert.equal(state.conversationMode, "agent");
    assert.equal(
      (
        await db.query("SELECT mode FROM conversations WHERE id=$1", [
          state.conversationId,
        ])
      ).rows[0].mode,
      "agent",
    );
    assert.equal((await run(["chat", "Hello"])).code, 0);
    const chatState = JSON.parse(
      await readFile(join(home, ".tokenhub", "config.json"), "utf8"),
    );
    assert.notEqual(chatState.conversationId, state.conversationId);
    assert.equal((await run(["chat", "Follow up"])).code, 0);
    assert.equal(
      JSON.parse(await readFile(join(home, ".tokenhub", "config.json"), "utf8"))
        .conversationId,
      chatState.conversationId,
    );
    usage = JSON.parse((await run(["status", "--json"])).output);
    assert.equal(
      usage.grants.find((g: any) => g.id === grant.grantId).used_tokens,
      800,
    );
    assert.equal((await run(["logout"])).code, 0);
    assert.equal((await run(["status"])).code, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("authentication rejects wrong credentials and cross-origin writes", async () => {
  assert.equal((await request("", "/me")).status, 401);
  assert.equal(
    (
      await request("", "/auth/login", {
        email: "Lender@example.com",
        password: "wrong",
      })
    ).status,
    401,
  );
  const r = await fetch(base + "/auth/register", {
    method: "POST",
    headers: {
      origin: "https://evil.example",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(r.status, 403);
  const me = await request(lender.cookie, "/me");
  assert.equal(me.data.user.id, lender.id);
  assert.equal(me.data.user.password, undefined);
});
test("encrypted credentials never appear in public lender data", async () => {
  const row = (
    await db.query("SELECT credential FROM connections WHERE user_id=$1", [
      lender.id,
    ])
  ).rows[0];
  assert.ok(!row.credential.includes("demo"));
  assert.equal(vault("11".repeat(32)).decrypt(row.credential), '{"demo":true}');
  assert.throws(() => vault("22".repeat(32)).decrypt(row.credential));
  const data = await request(borrower.cookie, "/offers");
  assert.ok(!JSON.stringify(data).includes("credential"));
});
test("borrower needs approval; only lender can approve; cap cannot be raised", async () => {
  const id = await offer();
  assert.equal(
    (
      await request(lender.cookie, "/offers/" + id + "/request", {
        note: "self",
      })
    ).status,
    400,
  );
  const r = await request(borrower.cookie, "/offers/" + id + "/request", {
    note: "please",
  });
  const grantId = r.data.id;
  assert.equal(
    (await request(borrower.cookie, "/conversations", { grantId })).status,
    404,
  );
  assert.equal(
    (
      await request(stranger.cookie, "/grants/" + grantId + "/approve", {
        tokenLimit: 1000,
        durationMinutes: 30,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(lender.cookie, "/grants/" + grantId + "/approve", {
        tokenLimit: 1001,
        durationMinutes: 30,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(lender.cookie, "/grants/" + grantId + "/approve", {
        tokenLimit: 1000,
        durationMinutes: 61,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(borrower.cookie, "/offers/" + id + "/request", {
        note: "again",
      })
    ).status,
    409,
  );
});
test("codes are borrower-bound, single-use, and absent before approval", async () => {
  const g = await approved();
  assert.equal(
    (await request(stranger.cookie, "/grants/" + g.grantId + "/code")).status,
    404,
  );
  assert.equal(
    (await request(stranger.cookie, "/redeem", { code: g.code })).status,
    400,
  );
  const results = await Promise.all([
    request(borrower.cookie, "/redeem", { code: g.code }),
    request(borrower.cookie, "/redeem", { code: g.code }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
  assert.equal(
    (await request(borrower.cookie, "/grants/" + g.grantId + "/code")).status,
    404,
  );
});
test("chat persists context and usage; other accounts cannot read history", async () => {
  const g = await active();
  const reply = await request(
    borrower.cookie,
    "/conversations/" + g.conversationId + "/messages",
    { content: "Explain generics" },
  );
  assert.equal(reply.status, 200, JSON.stringify(reply.data));
  assert.equal(reply.data.tokens, 200);
  const history = await request(
    borrower.cookie,
    "/conversations/" + g.conversationId + "/messages",
  );
  assert.equal(history.data.length, 2);
  assert.equal(history.data[1].role, "assistant");
  assert.equal(
    (
      await request(
        lender.cookie,
        "/conversations/" + g.conversationId + "/messages",
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        stranger.cookie,
        "/conversations/" + g.conversationId + "/messages",
        { content: "steal" },
      )
    ).status,
    404,
  );
  assert.equal(
    (await db.query("SELECT used_tokens FROM grants WHERE id=$1", [g.grantId]))
      .rows[0].used_tokens,
    200,
  );
});
test("final turn usage is counted fully and exhausted grants cannot call provider again", async () => {
  const g = await active(100);
  const before = calls;
  assert.equal(
    (
      await request(
        borrower.cookie,
        "/conversations/" + g.conversationId + "/messages",
        { content: "hello" },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        borrower.cookie,
        "/conversations/" + g.conversationId + "/messages",
        { content: "again" },
      )
    ).status,
    409,
  );
  assert.equal(calls, before + 1);
  assert.equal(
    (await db.query("SELECT used_tokens FROM grants WHERE id=$1", [g.grantId]))
      .rows[0].used_tokens,
    200,
  );
});
test("expired passes cannot redeem or start turns", async () => {
  const g = await approved();
  await db.query(
    "UPDATE grants SET expires_at=now()-interval '1 minute' WHERE id=$1",
    [g.grantId],
  );
  assert.equal(
    (await request(borrower.cookie, "/redeem", { code: g.code })).status,
    400,
  );
  const a = await active();
  await db.query(
    "UPDATE grants SET expires_at=now()-interval '1 minute' WHERE id=$1",
    [a.grantId],
  );
  const before = calls;
  assert.equal(
    (
      await request(
        borrower.cookie,
        "/conversations/" + a.conversationId + "/messages",
        { content: "late" },
      )
    ).status,
    409,
  );
  assert.equal(calls, before);
});
test("simultaneous requests serialize access to the lender connection", async () => {
  const a = await active(),
    b = await active();
  mode = "slow";
  const before = calls;
  const results = await Promise.all([
    request(
      borrower.cookie,
      "/conversations/" + a.conversationId + "/messages",
      { content: "one" },
    ),
    request(
      borrower.cookie,
      "/conversations/" + b.conversationId + "/messages",
      { content: "two" },
    ),
  ]);
  mode = "normal";
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(calls, before + 1);
});
test("revocation aborts an active turn and does not publish the answer", async () => {
  const g = await active();
  mode = "slow";
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const reply = request(
    borrower.cookie,
    "/conversations/" + g.conversationId + "/messages",
    { content: "long task" },
  );
  await started;
  resolveStarted = () => {};
  assert.equal(
    (await request(lender.cookie, "/grants/" + g.grantId + "/revoke", {}))
      .status,
    200,
  );
  const result = await reply;
  mode = "normal";
  assert.equal(result.status, 502);
  const history = await request(
    borrower.cookie,
    "/conversations/" + g.conversationId + "/messages",
  );
  assert.equal(
    history.data.filter((m: any) => m.role === "assistant").length,
    0,
  );
});
test("provider failure locks unknown usage and releases connection for other grants", async () => {
  const g = await active();
  mode = "fail";
  assert.equal(
    (
      await request(
        borrower.cookie,
        "/conversations/" + g.conversationId + "/messages",
        { content: "fail" },
      )
    ).status,
    502,
  );
  mode = "normal";
  assert.equal(
    (
      await request(
        borrower.cookie,
        "/conversations/" + g.conversationId + "/messages",
        { content: "retry" },
      )
    ).status,
    409,
  );
  const c = (
    await db.query("SELECT busy_id FROM connections WHERE user_id=$1", [
      lender.id,
    ])
  ).rows[0];
  assert.equal(c.busy_id, null);
});
test("stale interrupted turn fails closed after lease expiration", async () => {
  const g = await active();
  await db.query(
    "UPDATE grants SET busy_id=id,busy_until=now()-interval '1 second' WHERE id=$1",
    [g.grantId],
  );
  const before = calls;
  assert.equal(
    (
      await request(
        borrower.cookie,
        "/conversations/" + g.conversationId + "/messages",
        { content: "retry" },
      )
    ).status,
    409,
  );
  assert.equal(calls, before);
});
test("closing an offer stops new requests, without revoking existing passes", async () => {
  const g = await active();
  assert.equal(
    (await request(lender.cookie, "/offers/" + g.offerId + "/close", {}))
      .status,
    200,
  );
  assert.equal(
    (
      await request(stranger.cookie, "/offers/" + g.offerId + "/request", {
        note: "late",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        borrower.cookie,
        "/conversations/" + g.conversationId + "/messages",
        { content: "existing pass" },
      )
    ).status,
    200,
  );
});
test("CLI arguments disable agent capabilities and environment omits application secrets", () => {
  const args = cliArgs();
  for (const flag of [
    "--ignore-user-config",
    "--ephemeral",
    "features.shell_tool=false",
    "features.multi_agent=false",
    'web_search="disabled"',
  ])
    assert.ok(args.includes(flag));
  process.env.TOKENHUB_TEST_SECRET = "private";
  process.env.OPENAI_API_KEY = "must-not-inherit";
  const env = safeEnv("/isolated/home");
  assert.equal(env.TOKENHUB_TEST_SECRET, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CODEX_HOME, "/isolated/home");
  delete process.env.TOKENHUB_TEST_SECRET;
  delete process.env.OPENAI_API_KEY;
});

test("expiry cancels an in-flight response before releasing its output", async () => {
  const g = await active();
  await db.query(
    "UPDATE grants SET expires_at=now()+interval '150 milliseconds' WHERE id=$1",
    [g.grantId],
  );
  mode = "slow";
  const result = await request(
    borrower.cookie,
    "/conversations/" + g.conversationId + "/messages",
    { content: "expires during generation" },
  );
  mode = "normal";
  assert.equal(result.status, 502);
  const history = await request(
    borrower.cookie,
    "/conversations/" + g.conversationId + "/messages",
  );
  assert.equal(
    history.data.filter((m: any) => m.role === "assistant").length,
    0,
  );
});
test("parallel messages on the same pass admit only one provider turn", async () => {
  const g = await active();
  mode = "slow";
  const before = calls;
  const results = await Promise.all([
    request(
      borrower.cookie,
      "/conversations/" + g.conversationId + "/messages",
      { content: "one" },
    ),
    request(
      borrower.cookie,
      "/conversations/" + g.conversationId + "/messages",
      { content: "two" },
    ),
  ]);
  mode = "normal";
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(calls, before + 1);
});
test("redemption attempts are rate limited across requests", async () => {
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await request(stranger.cookie, "/redeem", { code: "invalid" })).status,
      400,
    );
  assert.equal(
    (await request(stranger.cookie, "/redeem", { code: "invalid" })).status,
    429,
  );
});

test("disconnect revokes all access and removes stored credentials", async () => {
  const g = await active();
  assert.equal(
    (await request(lender.cookie, "/connection", undefined, "DELETE")).status,
    200,
  );
  assert.equal(
    (
      await request(
        borrower.cookie,
        "/conversations/" + g.conversationId + "/messages",
        { content: "no connection" },
      )
    ).status,
    409,
  );
  assert.equal(
    (await db.query("SELECT 1 FROM connections WHERE user_id=$1", [lender.id]))
      .rows.length,
    0,
  );
});

test("application shutdown cancels active generation before closing the database", async () => {
  await request(lender.cookie, "/connection", {});
  const grant = await active();
  mode = "slow";
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const response = request(
    borrower.cookie,
    "/conversations/" + grant.conversationId + "/messages",
    { content: "work during restart" },
  );
  await started;
  resolveStarted = () => {};
  await close();
  const result = await response;
  mode = "normal";
  assert.equal(result.status, 502);
  const row = (
    await db.query(
      "SELECT busy_id,used_tokens,token_limit FROM grants WHERE id=$1",
      [grant.grantId],
    )
  ).rows[0];
  assert.equal(row.busy_id, null);
  assert.equal(row.used_tokens, row.token_limit);
  assert.equal(
    (
      await request(
        borrower.cookie,
        "/conversations/" + grant.conversationId + "/messages",
        { content: "after restart" },
      )
    ).status,
    503,
  );
});
