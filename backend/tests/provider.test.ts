import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createCodexProvider } from "../src/provider.js";
import { collectTurn } from "../src/cli-turn.js";

const message = {
  type: "item.completed",
  item: { type: "agent_message", text: "Hello from Codex." },
};
const usage = {
  type: "turn.completed",
  usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 12 },
};
function child(script: string) {
  return spawn(process.execPath, ["-e", script], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}
function events(values: unknown[]) {
  return (
    "process.stdin.resume();process.stdin.on('end',()=>{" +
    values
      .map(
        (value) =>
          "console.log(" + JSON.stringify(JSON.stringify(value)) + ");",
      )
      .join("") +
    "});"
  );
}
const run = (script: string) =>
  collectTurn(child(script), "[]", AbortSignal.timeout(5000));
test("CLI events return text and full usage without double counting cached input", async () => {
  const result = await run(
    events([{ type: "thread.started", thread_id: "private" }, message, usage]),
  );
  assert.deepEqual(result, { text: "Hello from Codex.", tokens: 132 });
});
test("CLI rejects malformed JSON, action items, missing usage, invalid text, and unsafe counts", async () => {
  const cases = [
    "process.stdin.resume();process.stdin.on('end',()=>console.log('not JSON'));",
    events([
      {
        type: "item.started",
        item: { type: "command_execution", command: "echo danger" },
      },
      message,
      usage,
    ]),
    events([message]),
    events([
      {
        ...message,
        item: { type: "agent_message", text: { secret: "private" } },
      },
      usage,
    ]),
    events([
      message,
      { ...usage, usage: { input_tokens: -1, output_tokens: 5 } },
    ]),
    events([
      message,
      {
        ...usage,
        usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 5 },
      },
    ]),
    events([message, usage, usage]),
    events([
      message,
      { type: "turn.failed", error: { message: "credential: secret-value" } },
    ]),
  ];
  for (const script of cases)
    await assert.rejects(run(script), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /could not complete/);
      assert.ok(!error.message.includes("secret-value"));
      return true;
    });
});
test("CLI handles fragmented unicode and final line without newline", async () => {
  const data = Buffer.from(
    JSON.stringify({
      ...message,
      item: { type: "agent_message", text: "Hello 🌍" },
    }) +
      "\n" +
      JSON.stringify(usage),
  );
  const script =
    "process.stdin.resume();process.stdin.on('end',async()=>{const b=Buffer.from(" +
    JSON.stringify([...data]) +
    ");for(const byte of b){process.stdout.write(Buffer.from([byte]));await new Promise(r=>setTimeout(r,1));}});";
  assert.deepEqual(await run(script), { text: "Hello 🌍", tokens: 132 });
});
test("CLI bounds output even when there is no newline", async () => {
  await assert.rejects(
    run("process.stdout.write('x'.repeat(2100000));setInterval(()=>{},1000);"),
    /could not complete/,
  );
});
test("CLI cancellation terminates a running child", async () => {
  const process = child("process.stdin.resume();setInterval(()=>{},1000);");
  const controller = new AbortController();
  const result = collectTurn(process, "[]", controller.signal);
  controller.abort();
  await assert.rejects(result, /cancelled/);
  assert.ok(process.exitCode !== null || process.signalCode !== null);
});
test("already cancelled CLI request closes without sending prompt", async () => {
  const process = child("process.stdin.resume();setInterval(()=>{},1000);");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    collectTurn(process, "private prompt", controller.signal),
    /cancelled/,
  );
});
test("CLI spawn errors close cleanly without exposing executable paths", async () => {
  const process = spawn("missing-tokenhub-executable-12345", [], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  await assert.rejects(
    collectTurn(process, "[]", AbortSignal.timeout(5000)),
    /could not complete/,
  );
});
for (const success of [true, false]) {
  test(
    "provider persists refreshed credentials and removes temporary files on " +
      (success ? "success" : "failure"),
    async () => {
      let tempHome = "";
      let saved = "";
      const provider = createCodexProvider((_args, home, cwd) => {
        tempHome = home;
        const script =
          "const fs=require('fs');const path=require('path');fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.json'),JSON.stringify({rotated:true}));" +
          events(success ? [message, usage] : [{ type: "turn.failed" }]);
        return spawn(process.execPath, ["-e", script], {
          cwd,
          env: { ...process.env, CODEX_HOME: home },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      });
      const result = provider.run(
        '{"initial":true}',
        [{ role: "user", content: "hello" }],
        AbortSignal.timeout(5000),
        async (value) => {
          saved = value;
        },
      );
      if (success) assert.equal((await result).tokens, 132);
      else await assert.rejects(result);
      assert.equal(saved, '{"rotated":true}');
      await assert.rejects(access(tempHome));
    },
  );
}
test("provider never starts a child for an already cancelled turn", async () => {
  let started = false;
  const provider = createCodexProvider(() => {
    started = true;
    throw new Error("should not run");
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    provider.run("{}", [], controller.signal, async () => {}),
  );
  assert.equal(started, false);
});
