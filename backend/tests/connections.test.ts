import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { Connections } from "../src/connections.js";
import { vault } from "../src/security.js";
import { migrate, type Database } from "../src/db.js";
import { createTestDatabase } from "./database.js";

let db: Database;
const crypto = vault("cd".repeat(32));
const credentials = JSON.stringify({
  tokens: { access_token: "test-access", refresh_token: "test-refresh" },
});
before(async () => {
  db = await createTestDatabase();
  await migrate(db);
});
after(async () => {
  await db.close();
});
async function user() {
  const id = randomUUID();
  await db.query(
    "INSERT INTO users(id,name,email,password) VALUES($1,'Login tester',$2,'not-a-real-password')",
    [id, id + "@example.test"],
  );
  return id;
}
const announce =
  "process.stdout.write('https://auth.openai.com/codex/device\\nABCD-1234\\n');";
const persist =
  "require('fs').writeFileSync(require('path').join(process.env.CODEX_HOME,'auth.json')," +
  JSON.stringify(credentials) +
  ");";
function starter(script: string, onStart?: (home: string) => void) {
  return (_args: string[], home: string, cwd: string) => {
    onStart?.(home);
    return spawn(process.execPath, ["-e", script], {
      cwd,
      env: { ...process.env, CODEX_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  };
}
async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for login lifecycle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
test("concurrent sign-in requests start only one device flow and expose only public fields", async () => {
  const id = await user();
  let starts = 0;
  let home = "";
  const manager = new Connections(db, crypto, false, {
    start: starter(announce + "setInterval(()=>{},1000);", (path) => {
      starts++;
      home = path;
    }),
  });
  try {
    await Promise.all([manager.begin(id), manager.begin(id)]);
    await waitFor(async () => (await manager.status(id)).state === "pending");
    assert.deepEqual(await manager.status(id), {
      state: "pending",
      url: "https://auth.openai.com/codex/device",
      code: "ABCD-1234",
    });
    assert.equal(starts, 1);
    await manager.cancel(id);
    assert.deepEqual(await manager.status(id), { state: "failed" });
  } finally {
    await manager.close();
  }
  await assert.rejects(access(home));
});
test("successful device login stores encrypted credentials and status survives manager restart", async () => {
  const id = await user();
  let home = "";
  const manager = new Connections(db, crypto, false, {
    start: starter(persist, (path) => {
      home = path;
    }),
  });
  await manager.begin(id);
  await waitFor(async () => (await manager.status(id)).state === "connected");
  await manager.close();
  const row = (
    await db.query("SELECT credential FROM connections WHERE user_id=$1", [id])
  ).rows[0];
  assert.equal(crypto.decrypt(row.credential), credentials);
  assert.ok(!row.credential.includes("test-access"));
  await assert.rejects(access(home));
  const restarted = new Connections(db, crypto, false, {
    start: () => {
      throw new Error("must not restart a connected login");
    },
  });
  assert.deepEqual(await restarted.status(id), { state: "connected" });
  assert.deepEqual(await restarted.begin(id), { state: "connected" });
  await restarted.close();
});
test("device code parsing handles split output and ANSI colors", async () => {
  const id = await user();
  const script =
    "process.stdout.write('\\x1b[32mhttps://auth.open');setTimeout(()=>process.stdout.write('ai.com/codex/device\\x1b[0m\\nABCD-'),20);setTimeout(()=>process.stdout.write('1234\\n'),40);setInterval(()=>{},1000);";
  const manager = new Connections(db, crypto, false, {
    start: starter(script),
  });
  try {
    await manager.begin(id);
    await waitFor(async () => (await manager.status(id)).state === "pending");
    const status = await manager.status(id);
    assert.ok("code" in status);
    assert.equal(status.code, "ABCD-1234");
  } finally {
    await manager.close();
  }
});
test("startup failure cleans temporary files and allows a new attempt", async () => {
  const id = await user();
  let home = "";
  let fail = true;
  const manager = new Connections(db, crypto, false, {
    start: (args, path, cwd) => {
      home = path;
      if (fail) throw new Error("native binary unavailable");
      return starter(persist)(args, path, cwd);
    },
  });
  await assert.rejects(manager.begin(id), /could not start/);
  await assert.rejects(access(home));
  assert.equal((await manager.status(id)).state, "failed");
  fail = false;
  await manager.begin(id);
  await waitFor(async () => (await manager.status(id)).state === "connected");
  await manager.close();
});
test("invalid auth files are rejected and never mark the account connected", async () => {
  const id = await user();
  const script =
    "require('fs').writeFileSync(require('path').join(process.env.CODEX_HOME,'auth.json'),JSON.stringify({tokens:{},OPENAI_API_KEY:'not-chatgpt'}));";
  const manager = new Connections(db, crypto, false, {
    start: starter(script),
  });
  await manager.begin(id);
  await waitFor(async () => (await manager.status(id)).state === "failed");
  await manager.close();
  assert.equal(
    (await db.query("SELECT 1 FROM connections WHERE user_id=$1", [id])).rows
      .length,
    0,
  );
});
test("timeout terminates device login and removes its displayed code", async () => {
  const id = await user();
  let home = "";
  const manager = new Connections(db, crypto, false, {
    timeoutMs: 180,
    start: starter(announce + "setInterval(()=>{},1000);", (path) => {
      home = path;
    }),
  });
  await manager.begin(id);
  await waitFor(async () => (await manager.status(id)).state === "failed");
  assert.deepEqual(await manager.status(id), { state: "failed" });
  await manager.close();
  await assert.rejects(access(home));
});
test("disconnect cannot race a completing login into restoring credentials", async () => {
  const id = await user();
  let entered!: () => void;
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slowDb: Database = {
    ...db,
    query: async (sql, values) => {
      if (sql.startsWith("INSERT INTO connections")) {
        entered();
        await gate;
      }
      return db.query(sql, values);
    },
  };
  const manager = new Connections(slowDb, crypto, false, {
    start: starter(persist),
  });
  await manager.begin(id);
  await entering;
  const disconnect = manager.disconnect(id);
  release();
  await disconnect;
  await manager.close();
  assert.equal(
    (await db.query("SELECT 1 FROM connections WHERE user_id=$1", [id])).rows
      .length,
    0,
  );
  assert.deepEqual(await manager.status(id), { state: "failed" });
});
test("shutdown cancels sign-in without waiting for device-code expiration", async () => {
  const id = await user();
  let home = "";
  const manager = new Connections(db, crypto, false, {
    start: starter(announce + "setInterval(()=>{},1000);", (path) => {
      home = path;
    }),
  });
  await manager.begin(id);
  await manager.close();
  await assert.rejects(access(home));
  await assert.rejects(manager.begin(id), /shutting down/);
  assert.equal(
    (await db.query("SELECT 1 FROM connections WHERE user_id=$1", [id])).rows
      .length,
    0,
  );
});
