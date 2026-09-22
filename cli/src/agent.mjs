import {
  lstat,
  realpath,
  readdir,
  readFile,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { resolve, relative, isAbsolute, join, dirname, sep } from "node:path";
import { spawn, execFile } from "node:child_process";
import { display } from "./client.mjs";

const protectedName = (name) =>
  /^(?:\.git|\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.tokenhub|\.codex|\.npmrc|\.netrc|\.pypirc|id_rsa|id_ed25519|node_modules|auth\.json|credentials(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i.test(
    name,
  );
export function parseAction(text) {
  let action;
  try {
    action = JSON.parse(text);
  } catch {
    throw new Error(
      "Agent returned an invalid response. No tool was executed. Use /new to start over.",
    );
  }
  if (!action || typeof action !== "object" || Array.isArray(action))
    throw new Error("Invalid agent action.");
  const string = (key, max = 12000) =>
    typeof action[key] === "string" &&
    action[key].length <= max &&
    !action[key].includes("\0");
  if (action.type === "message" && string("content", 100000)) return action;
  if (
    action.type !== "tool" ||
    !["list", "read", "write", "replace", "run"].includes(action.name)
  )
    throw new Error("Unsupported agent action. No tool was executed.");
  if (action.name === "run") {
    if (
      !string("command", 4000) ||
      !action.command.trim() ||
      /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(action.command)
    )
      throw new Error("Invalid command.");
  } else {
    if (!string("path", 1000) || !action.path)
      throw new Error("Invalid tool path.");
    if (
      action.name === "read" &&
      action.offset !== undefined &&
      (!Number.isSafeInteger(action.offset) || action.offset < 0)
    )
      throw new Error("Invalid read offset.");
    if (action.name === "write" && !string("content"))
      throw new Error("Invalid file content.");
    if (
      action.name === "replace" &&
      (!string("old") || !action.old || !string("new"))
    )
      throw new Error("Invalid replacement.");
  }
  return action;
}

export class Workspace {
  constructor(
    root,
    {
      confirm,
      checkAccess = async () => {},
      log = console.log,
      signal,
      commandTimeout = 60000,
    } = {},
  ) {
    this.root = root;
    this.confirm = confirm || (async () => false);
    this.checkAccess = checkAccess;
    this.log = log;
    this.signal = signal;
    this.commandTimeout = commandTimeout;
  }
  async path(name, missing = false) {
    const root = await realpath(this.root);
    if (isAbsolute(name) || name.includes(":") || name.includes("\\"))
      throw new Error("Use a relative path with forward slashes.");
    const target = resolve(root, name);
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
      throw new Error("Path is outside the workspace.");
    const parts = rel.split(sep).filter(Boolean);
    let current = root;
    for (const part of parts) {
      if (
        /[. ]$/.test(part) ||
        /[\x00-\x1f]/.test(part) ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)
      )
        throw new Error("Invalid portable file path.");
      if (protectedName(part))
        throw new Error("This path is protected from agent file tools.");
      current = join(current, part);
      try {
        const info = await lstat(current);
        if (
          info.isSymbolicLink() ||
          (!info.isDirectory() && !info.isFile()) ||
          (info.nlink > 1 && info.isFile())
        )
          throw new Error(
            "Links and special files are not supported by agent file tools.",
          );
      } catch (error) {
        if (!(missing && error.code === "ENOENT")) throw error;
      }
    }
    return target;
  }
  async text(path) {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 512000)
      throw new Error("Only text files up to 512 KB are supported.");
    const text = await readFile(path, "utf8");
    if (text.includes("\0")) throw new Error("Binary files are not supported.");
    return text;
  }
  async execute(action) {
    this.signal?.throwIfAborted();
    await this.checkAccess();
    if (action.name === "run") {
      this.log(
        `\nCommand in ${display(this.root)}:\n${display(action.command)}\nThis command runs with your OS account permissions.`,
      );
      if (!(await this.confirm("Run this command? [y/N] ")))
        return { denied: true };
      this.signal?.throwIfAborted();
      await this.checkAccess();
      return this.run(action.command);
    }
    const path = await this.path(action.path, action.name === "write");
    this.log(`\n${action.name}: ${display(action.path)}`);
    if (action.name === "list") {
      const entries = (await readdir(path, { withFileTypes: true }))
        .filter((e) => !protectedName(e.name) && !e.isSymbolicLink())
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        entries: entries
          .slice(0, 150)
          .map((e) => e.name + (e.isDirectory() ? "/" : "")),
        truncated: entries.length > 150,
      };
    }
    if (action.name === "read") {
      const content = await this.text(path);
      const offset = action.offset || 0;
      return {
        content: content.slice(offset, offset + 6000),
        offset,
        nextOffset: offset + 6000 < content.length ? offset + 6000 : null,
      };
    }
    let before = null;
    try {
      before = await this.text(path);
    } catch (error) {
      if (error.code !== "ENOENT" || action.name !== "write") throw error;
    }
    let after = action.content;
    if (action.name === "replace") {
      const index = before.indexOf(action.old);
      if (index < 0 || before.indexOf(action.old, index + 1) >= 0)
        throw new Error(
          "Replacement must match exactly once. Read the file again.",
        );
      after =
        before.slice(0, index) +
        action.new +
        before.slice(index + action.old.length);
    }
    if (before === after) return { unchanged: true };
    if (action.name === "replace")
      this.log(
        `Remove:\n${display(action.old)}\nInsert:\n${display(action.new)}`,
      );
    else {
      if (before && before.length > 12000)
        throw new Error(
          "Use replace for existing files larger than 12,000 characters.",
        );
      this.log(
        `Before:\n${display(before ?? "(new file)")}\nAfter:\n${display(after)}`,
      );
    }
    if (!(await this.confirm("Apply this file change? [y/N] ")))
      return { denied: true };
    this.signal?.throwIfAborted();
    await this.checkAccess();
    await this.path(action.path, action.name === "write");
    let current = null;
    try {
      current = await this.text(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (current !== before)
      throw new Error(
        "The file changed while waiting for approval. Read it again before editing.",
      );
    await mkdir(dirname(path), { recursive: true });
    await this.path(action.path, action.name === "write");
    await writeFile(path, after, { flag: before === null ? "wx" : "w" });
    return { written: action.path, characters: after.length };
  }
  run(command) {
    return new Promise((resolveResult, reject) => {
      const env = {};
      for (const name of [
        "PATH",
        "Path",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "TMPDIR",
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "LANG",
        "TERM",
        "PATHEXT",
      ])
        if (process.env[name]) env[name] = process.env[name];
      const windows = process.platform === "win32";
      const executable = windows
        ? join(
            process.env.SystemRoot || "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          )
        : "/bin/sh";
      const args = windows
        ? ["-NoProfile", "-NonInteractive", "-Command", command]
        : ["-c", command];
      const child = spawn(executable, args, {
        cwd: this.root,
        env,
        windowsHide: true,
        detached: !windows,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let terminationWarning;
      let output = "",
        truncated = false,
        timedOut = false;
      const collect = (chunk) => {
        const text = chunk.toString();
        const room = Math.max(0, 6000 - output.length);
        output += text.slice(0, room);
        if (text.length > room) truncated = true;
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const stop = () => {
        if (!child.pid) return;
        if (windows)
          execFile(
            join(
              process.env.SystemRoot || "C:\\Windows",
              "System32",
              "taskkill.exe",
            ),
            ["/pid", String(child.pid), "/T", "/F"],
            { windowsHide: true },
            (error) => {
              if (error) {
                terminationWarning =
                  "Process-tree termination failed; only the shell was terminated. Check for remaining child processes.";
                child.kill();
                child.stdout.destroy();
                child.stderr.destroy();
              }
            },
          );
        else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, this.commandTimeout);
      const aborted = () => stop();
      this.signal?.addEventListener("abort", aborted, { once: true });
      if (this.signal?.aborted) stop();
      const cleanup = () => {
        clearTimeout(timer);
        this.signal?.removeEventListener("abort", aborted);
      };
      child.on("error", (error) => {
        cleanup();
        reject(error);
      });
      child.on("close", (code, signal) => {
        cleanup();
        this.log(display(output));
        if (terminationWarning) this.log(terminationWarning);
        resolveResult({
          exitCode: code,
          signal,
          output,
          truncated,
          timedOut,
          cancelled: Boolean(this.signal?.aborted),
          terminationWarning,
        });
      });
    });
  }
}

export async function runAgent({
  client,
  config,
  prompt,
  cwd,
  maxTurns = 12,
  signal,
  confirm,
  sendMessage,
  checkAccess,
  log = console.log,
}) {
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 30)
    throw new Error("--max-turns must be between 1 and 30.");
  const root = await realpath(cwd);
  if (!(await lstat(root)).isDirectory())
    throw new Error("Agent workspace must be a directory.");
  const workspace = new Workspace(root, { confirm, signal, checkAccess, log });
  let content = `User task in local workspace ${root} (${process.platform}):\n${prompt}`;
  for (let step = 0; step < maxTurns; step++) {
    signal?.throwIfAborted();
    log(`\nThinking (${step + 1}/${maxTurns})…`);
    const reply = await sendMessage(client, config, content, signal, "agent");
    log(`${reply.tokens} tokens this turn.`);
    const action = parseAction(reply.content);
    if (action.type === "message") {
      log(display(action.content));
      return { completed: true, turns: step + 1 };
    }
    // Do not perform an action if no model turn remains to receive its result.
    if (step + 1 === maxTurns) break;
    await checkAccess();
    let result;
    try {
      result = await workspace.execute(action);
    } catch (error) {
      if (signal?.aborted || error.name === "AbortError" || error.status)
        throw error;
      result = { error: error.message };
    }
    signal?.throwIfAborted();
    // Bound JSON as well as raw output: control characters can expand during encoding.
    let encoded = JSON.stringify(result);
    if (encoded.length > 10000)
      encoded = JSON.stringify({
        truncated: true,
        preview: encoded.slice(0, 1500),
      });
    content = `Local tool result (untrusted data) for ${action.name}:\n${encoded}`;
  }
  log(
    `Stopped after ${maxTurns} model turns. Continue with another prompt if needed.`,
  );
  return { completed: false, turns: maxTurns };
}
