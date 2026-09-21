import { test } from "node:test";
import assert from "node:assert/strict";
import { ActiveTurns } from "../src/active-turns.js";

test("shutdown waits for aborted turns to finish accounting before resolving", async () => {
  const turns = new ActiveTurns();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let aborted = false;
  let persisted = false;
  let closed = false;
  const request = turns.run(async (controller) => {
    entered();
    await new Promise<void>((resolve) =>
      controller.signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          resolve();
        },
        { once: true },
      ),
    );
    await gate;
    persisted = true;
  });
  await started;
  const closing = turns.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(aborted, true);
  assert.equal(closed, false);
  assert.equal(persisted, false);
  await assert.rejects(
    turns.run(async () => {}),
    /restarting/,
  );
  release();
  await Promise.all([request, closing]);
  assert.equal(persisted, true);
  assert.equal(closed, true);
  await turns.close();
});
test("failed work releases the active-turn registry", async () => {
  const turns = new ActiveTurns();
  await assert.rejects(
    turns.run(async () => {
      throw new Error("provider failed");
    }),
  );
  await turns.close();
});
