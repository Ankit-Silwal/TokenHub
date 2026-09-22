import {
  mkdir,
  readFile,
  writeFile,
  rename,
  chmod,
  lstat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function serverUrl(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "Use a server origin, e.g. https://tokenhub.example.com (no path or credentials).",
    );
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("Use HTTPS, or HTTP on localhost for development.");
  return url.origin;
}
export class Config {
  constructor(
    home = process.env.TOKENHUB_HOME || join(homedir(), ".tokenhub"),
  ) {
    this.home = home;
    this.file = join(home, "config.json");
    this.data = {};
  }
  async load() {
    try {
      if ((await lstat(this.file)).isSymbolicLink())
        throw new Error("Config must not be a symbolic link.");
      this.data = JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this;
  }
  async save() {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const temporary = join(this.home, `.config-${randomUUID()}.json`);
    await writeFile(temporary, JSON.stringify(this.data, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, this.file);
    await chmod(this.file, 0o600);
  }
}
export class Client {
  constructor(config, fetcher = fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }
  async request(path, body, { anonymous = false, signal } = {}) {
    const { server, token } = this.config.data;
    if (!server || (!anonymous && !token))
      throw new Error("Run tokenhub login --server <URL> first.");
    const response = await this.fetcher(serverUrl(server) + "/api" + path, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(!anonymous ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(135000)])
        : AbortSignal.timeout(135000),
    });
    const data = await response.json().catch(() => {
      throw new Error(
        "Server did not return JSON. Check the TokenHub server URL.",
      );
    });
    if (!response.ok) {
      const error = new Error(
        data.error || `Request failed (${response.status}).`,
      );
      error.status = response.status;
      throw error;
    }
    return data;
  }
}
// Strip terminal control sequences from remote/model-controlled output.
export const display = (value) =>
  String(value)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
export function printUsage(data, selected, log = console.log) {
  log(`Provider: ${data.provider} | Token limits apply to every agent turn.`);
  for (const g of data.grants)
    log(
      `${g.id === selected ? "*" : " "} ${g.id}  ${display(g.title)}\n  ${g.effective_status} | ${g.used_tokens.toLocaleString()} / ${g.token_limit.toLocaleString()} used | ${g.remaining_tokens.toLocaleString()} left | expires ${g.expires_at || "pending"}`,
    );
  if (!data.grants.length)
    log("No access passes. Run tokenhub offers to find one.");
  log(
    "Usage includes input and output. The final admitted turn may exceed the remaining allowance.",
  );
}
