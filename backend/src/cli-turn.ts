import { createInterface } from "node:readline";
import type { ChildProcess } from "node:child_process";
import type { Reply } from "./provider.js";

const failureMessage =
  "Codex could not complete this response. Ask the lender to check their connection.";
const maxOutputBytes = 2_000_000;

export function collectTurn(
  child: ChildProcess,
  prompt: string,
  signal: AbortSignal,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let invalid = false;
    let completed = false;
    let tokens: number | undefined;
    const messages: string[] = [];
    let forceStop: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      child.kill();
      forceStop ??= setTimeout(() => child.kill("SIGKILL"), 1000);
      forceStop.unref();
    };
    const fail = () => {
      invalid = true;
      stop();
    };
    // Bound output before readline buffers it, including output without a newline.
    child.stdout!.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) fail();
    });
    const lines = createInterface({ input: child.stdout! });
    child.stderr!.on("data", () => {}); // Never expose authentication diagnostics.
    lines.on("line", (line) => {
      if (invalid || signal.aborted) return;
      try {
        const event = JSON.parse(line);
        if (
          !event ||
          typeof event !== "object" ||
          typeof event.type !== "string"
        )
          return fail();
        if (event.type === "turn.failed" || event.type === "error")
          return fail();
        if (
          event.item &&
          !["agent_message", "reasoning"].includes(event.item.type)
        )
          return fail();
        if (
          event.type === "item.completed" &&
          event.item?.type === "agent_message"
        ) {
          if (completed || typeof event.item.text !== "string") return fail();
          messages.push(event.item.text);
        }
        if (event.type === "turn.completed") {
          const input = event.usage?.input_tokens;
          const output = event.usage?.output_tokens;
          if (
            completed ||
            !Number.isSafeInteger(input) ||
            input < 0 ||
            !Number.isSafeInteger(output) ||
            output < 0 ||
            !Number.isSafeInteger(input + output)
          )
            return fail();
          tokens = input + output;
          completed = true;
        }
      } catch {
        fail();
      }
    });
    const cancel = () => stop();
    signal.addEventListener("abort", cancel, { once: true });
    child.once("error", () => {
      invalid = true;
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", cancel);
      if (forceStop) clearTimeout(forceStop);
      lines.close();
      const text = messages.join("\n\n").trim();
      if (signal.aborted) reject(new Error("Response cancelled."));
      else if (
        code !== 0 ||
        invalid ||
        !completed ||
        tokens === undefined ||
        !text
      )
        reject(new Error(failureMessage));
      else resolve({ text, tokens });
    });
    child.stdin!.on("error", () => {
      invalid = true;
    });
    if (signal.aborted) cancel();
    else child.stdin!.end(prompt);
  });
}
