import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, parseAction, runAgent } from "../src/agent.mjs";

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "tokenhub-agent-test-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("invalid model actions cannot invoke tools", () => {
  for (const text of [
    "not json",
    "null",
    "[]",
    '{"type":"tool","name":"delete","path":"."}',
    '{"type":"tool","name":"run","command":[]}',
    '{"type":"tool","name":"read","path":"a","offset":-1}',
  ])
    assert.throws(() => parseAction(text));
  assert.equal(
    parseAction('{"type":"message","content":"done"}').content,
    "done",
  );
});
test("file tools confine paths and refuse protected files and junctions", () =>
  fixture(async (root) => {
    const workspace = new Workspace(root, { log() {} });
    await writeFile(join(root, "example.txt"), "hello");
    for (const path of [
      "../outside",
      ".env",
      ".git/config",
      ".codex/auth.json",
      "C:/secret",
      "a\\b",
    ])
      await assert.rejects(workspace.path(path, true));
    await mkdir(join(root, "real"));
    await symlink(
      join(root, "real"),
      join(root, "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(workspace.path("link/file", true), /Links/);
    assert.equal(
      (await workspace.execute({ name: "read", path: "example.txt" })).content,
      "hello",
    );
  }));
test("writes require approval, recheck access, and preserve concurrent changes", () =>
  fixture(async (root) => {
    await writeFile(join(root, "example.txt"), "original");
    const action = { name: "write", path: "example.txt", content: "changed" };
    const denied = new Workspace(root, {
      log() {},
      confirm: async () => false,
    });
    assert.deepEqual(await denied.execute(action), { denied: true });
    assert.equal(await readFile(join(root, "example.txt"), "utf8"), "original");
    let checks = 0;
    const accepted = new Workspace(root, {
      log() {},
      confirm: async () => true,
      checkAccess: async () => {
        checks++;
      },
    });
    await accepted.execute(action);
    assert.equal(checks, 2);
    assert.equal(await readFile(join(root, "example.txt"), "utf8"), "changed");
    const revoked = new Workspace(root, {
      log() {},
      confirm: async () => true,
      checkAccess: async () => {
        if (++checks > 3) throw new Error("Revoked");
      },
    });
    await assert.rejects(
      revoked.execute({ ...action, content: "bad" }),
      /Revoked/,
    );
    const racing = new Workspace(root, {
      log() {},
      confirm: async () => {
        await writeFile(join(root, "example.txt"), "user edit");
        return true;
      },
    });
    await assert.rejects(
      racing.execute({ ...action, content: "next edit" }),
      /changed while waiting/,
    );
    assert.equal(
      await readFile(join(root, "example.txt"), "utf8"),
      "user edit",
    );
  }));
test("replacement requires a unique match and preserves unrelated content", () =>
  fixture(async (root) => {
    const workspace = new Workspace(root, {
      log() {},
      confirm: async () => true,
    });
    await writeFile(join(root, "example.txt"), "a\nb\na");
    await assert.rejects(
      workspace.execute({
        name: "replace",
        path: "example.txt",
        old: "a",
        new: "x",
      }),
      /exactly once/,
    );
    await workspace.execute({
      name: "replace",
      path: "example.txt",
      old: "b",
      new: "new",
    });
    assert.equal(
      await readFile(join(root, "example.txt"), "utf8"),
      "a\nnew\na",
    );
  }));
test("commands require approval, omit TokenHub secrets and bound output", () =>
  fixture(async (root) => {
    const denied = new Workspace(root, { log() {} });
    assert.deepEqual(
      await denied.execute({ name: "run", command: "never-run-this" }),
      { denied: true },
    );
    process.env.TOKENHUB_PASSWORD = "must-not-leak";
    try {
      const workspace = new Workspace(root, {
        log() {},
        confirm: async () => true,
      });
      const command =
        process.platform === "win32"
          ? "Write-Output $env:TOKENHUB_PASSWORD; Write-Output ('x' * 9000)"
          : "printf '%s' \"$TOKENHUB_PASSWORD\"; printf '%09000d' 0";
      const result = await workspace.execute({ name: "run", command });
      assert.equal(result.exitCode, 0);
      assert.equal(result.output.includes("must-not-leak"), false);
      assert.equal(result.output.length, 6000);
      assert.equal(result.truncated, true);
    } finally {
      delete process.env.TOKENHUB_PASSWORD;
    }
  }));
test("command timeout stops the shell promptly", () =>
  fixture(async (root) => {
    const start = Date.now();
    const workspace = new Workspace(root, {
      log() {},
      confirm: async () => true,
      commandTimeout: 150,
    });
    const result = await workspace.execute({
      name: "run",
      command:
        process.platform === "win32" ? "Start-Sleep -Seconds 20" : "sleep 20",
    });
    assert.equal(result.timedOut, true);
    assert.ok(
      Date.now() - start < 5000,
      "Command must stop promptly after its timeout",
    );
  }));

test("cancelling an approval stops the agent without another model request", () =>
  fixture(async (root) => {
    let calls = 0;
    await assert.rejects(
      runAgent({
        cwd: root,
        prompt: "create a file",
        log() {},
        checkAccess: async () => {},
        confirm: async () => {
          throw new DOMException("Cancelled", "AbortError");
        },
        sendMessage: async () => {
          calls++;
          return {
            content: JSON.stringify({
              type: "tool",
              name: "write",
              path: "new.txt",
              content: "new",
            }),
            tokens: 10,
          };
        },
      }),
      { name: "AbortError" },
    );
    assert.equal(calls, 1);
    await assert.rejects(readFile(join(root, "new.txt")), { code: "ENOENT" });
  }));
test("agent sends tool results through metered turns and stops at completion", () =>
  fixture(async (root) => {
    await writeFile(join(root, "example.txt"), "original");
    const replies = [
      { type: "tool", name: "read", path: "example.txt" },
      {
        type: "tool",
        name: "replace",
        path: "example.txt",
        old: "original",
        new: "fixed",
      },
      { type: "message", content: "Done" },
    ];
    const prompts = [];
    const result = await runAgent({
      cwd: root,
      prompt: "fix it",
      checkAccess: async () => {},
      confirm: async () => true,
      log() {},
      sendMessage: async (_client, _config, content, _signal, mode) => {
        assert.equal(mode, "agent");
        prompts.push(content);
        return { content: JSON.stringify(replies.shift()), tokens: 100 };
      },
    });
    assert.equal(result.completed, true);
    assert.equal(prompts.length, 3);
    assert.match(prompts[1], /original/);
    assert.match(prompts[2], /written/);
    assert.equal(await readFile(join(root, "example.txt"), "utf8"), "fixed");
  }));
test("exhausted access and turn bounds prevent further local actions", () =>
  fixture(async (root) => {
    let approvals = 0;
    const options = {
      cwd: root,
      prompt: "create",
      log() {},
      confirm: async () => {
        approvals++;
        return true;
      },
      sendMessage: async () => ({
        content: JSON.stringify({
          type: "tool",
          name: "write",
          path: "new.txt",
          content: "x",
        }),
        tokens: 100,
      }),
    };
    await assert.rejects(
      runAgent({
        ...options,
        checkAccess: async () => {
          throw new Error("exhausted");
        },
      }),
      /exhausted/,
    );
    const bounded = await runAgent({
      ...options,
      maxTurns: 1,
      checkAccess: async () => {},
    });
    assert.equal(bounded.completed, false);
    assert.equal(approvals, 0);
    await assert.rejects(readFile(join(root, "new.txt")), { code: "ENOENT" });
  }));
