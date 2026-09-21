import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { startCli } from "./provider.js";
import type { Database } from "./db.js";
import { vault } from "./security.js";
import { HttpError } from "./errors.js";

type Login = {
  state: "starting" | "pending" | "connected" | "failed";
  url?: string;
  code?: string;
  expires: number;
  child?: ChildProcess;
  cancelled: boolean;
  done?: Promise<void>;
  stop?: () => void;
};
const authSchema = z.object({
  tokens: z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
  }),
});
type Options = { start?: typeof startCli; timeoutMs?: number };

export class Connections {
  private logins = new Map<string, Login>();
  private operations = new Map<string, Promise<unknown>>();
  private closed = false;
  constructor(
    private db: Database,
    private crypto: ReturnType<typeof vault>,
    private demo: boolean,
    private options: Options = {},
  ) {}

  private exclusive<T>(userId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(userId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    this.operations.set(userId, current);
    const remove = () => {
      if (this.operations.get(userId) === current)
        this.operations.delete(userId);
    };
    void current.then(remove, remove);
    return current;
  }
  private invalidate(login?: Login) {
    if (!login) return;
    login.cancelled = true;
    login.state = "failed";
    login.url = undefined;
    login.code = undefined;
    login.stop?.();
  }
  private view(login: Login) {
    return login.state === "pending"
      ? { state: login.state, url: login.url, code: login.code }
      : { state: login.state };
  }

  begin(userId: string) {
    return this.exclusive(userId, async () => {
      if (this.closed) throw new HttpError(503, "Server is shutting down.");
      const existing = this.logins.get(userId);
      if (
        existing &&
        existing.expires > Date.now() &&
        ["starting", "pending"].includes(existing.state)
      )
        return this.view(existing);
      this.invalidate(existing);
      if (
        (
          await this.db.query("SELECT 1 FROM connections WHERE user_id=$1", [
            userId,
          ])
        ).rows.length
      )
        return { state: "connected" };
      if (this.demo) {
        await this.save(userId, '{"demo":true}');
        return { state: "connected" };
      }
      const timeoutMs = this.options.timeoutMs ?? 10 * 60_000;
      const login: Login = {
        state: "starting",
        expires: Date.now() + timeoutMs,
        cancelled: false,
      };
      this.logins.set(userId, login);
      let home: string | undefined;
      try {
        home = await mkdtemp(join(tmpdir(), "tokenhub-login-"));
        await writeFile(
          join(home, "config.toml"),
          'cli_auth_credentials_store = "file"\n',
          { mode: 0o600 },
        );
        const child = (this.options.start ?? startCli)(
          ["login", "--device-auth"],
          home,
          home,
        );
        login.child = child;
        let forceStop: ReturnType<typeof setTimeout> | undefined;
        login.stop = () => {
          child.kill();
          forceStop ??= setTimeout(() => child.kill("SIGKILL"), 1000);
          forceStop.unref();
        };
        const timeout = setTimeout(() => this.invalidate(login), timeoutMs);
        timeout.unref();
        let output = "";
        const parse = (chunk: Buffer) => {
          if (login.cancelled || this.logins.get(userId) !== login) return;
          output = (output + chunk.toString()).slice(-8192);
          const text = output.replace(/\u001b\[[0-9;]*m/g, "");
          const url = text.match(
            /https:\/\/auth\.openai\.com\/codex\/device\b/,
          );
          const code = text.match(/\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\b/);
          if (url) login.url = url[0];
          if (code) login.code = code[0];
          if (login.url && login.code) login.state = "pending";
        };
        child.stdout!.on("data", parse);
        child.stderr!.on("data", parse);
        child.stdin!.on("error", () => {});
        child.stdin!.end();
        child.on("error", () => this.invalidate(login));
        const loginHome = home;
        login.done = new Promise<void>((resolve) => {
          child.once("close", (code) => {
            clearTimeout(timeout);
            if (forceStop) clearTimeout(forceStop);
            void this.exclusive(userId, async () => {
              try {
                if (
                  code !== 0 ||
                  login.cancelled ||
                  this.closed ||
                  Date.now() >= login.expires ||
                  this.logins.get(userId) !== login
                )
                  throw new Error("Login no longer active");
                const auth = await readFile(
                  join(loginHome, "auth.json"),
                  "utf8",
                );
                authSchema.parse(JSON.parse(auth));
                await this.save(userId, auth);
                login.state = "connected";
              } catch {
                login.state = "failed";
              } finally {
                login.url = undefined;
                login.code = undefined;
                login.child = undefined;
                login.stop = undefined;
                // A cleanup failure must not create an unhandled rejection or keep shutdown waiting.
                await rm(loginHome, { recursive: true, force: true }).catch(
                  () => {
                    login.state = "failed";
                  },
                );
              }
            })
              .finally(resolve)
              .catch(() => {});
          });
        });
        return this.view(login);
      } catch {
        this.invalidate(login);
        if (home) await rm(home, { recursive: true, force: true });
        throw new HttpError(
          503,
          "Codex sign-in could not start. Check the CLI installation and try again.",
        );
      }
    });
  }
  private async save(userId: string, auth: string) {
    await this.db.query(
      "INSERT INTO connections(user_id,credential) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET credential=$2,updated_at=now()",
      [userId, this.crypto.encrypt(auth)],
    );
  }
  async status(userId: string) {
    const login = this.logins.get(userId);
    if (login && ["starting", "pending"].includes(login.state)) {
      if (Date.now() >= login.expires) this.invalidate(login);
      return this.view(login);
    }
    if (
      (
        await this.db.query("SELECT 1 FROM connections WHERE user_id=$1", [
          userId,
        ])
      ).rows.length
    )
      return { state: "connected" };
    return { state: login?.state === "failed" ? "failed" : "idle" };
  }
  cancel(userId: string) {
    return this.exclusive(userId, async () => {
      this.invalidate(this.logins.get(userId));
    });
  }
  disconnect(userId: string) {
    return this.exclusive(userId, async () => {
      this.invalidate(this.logins.get(userId));
      await this.db.query(
        "UPDATE grants SET status=$2,code_hash=NULL,code_cipher=NULL WHERE offer_id IN (SELECT id FROM offers WHERE lender_id=$1) AND status IN ($3,$4,$5)",
        [userId, "revoked", "active", "approved", "pending"],
      );
      await this.db.query("UPDATE offers SET active=false WHERE lender_id=$1", [
        userId,
      ]);
      await this.db.query("DELETE FROM connections WHERE user_id=$1", [userId]);
    });
  }
  async close() {
    this.closed = true;
    await Promise.all(
      [...new Set([...this.logins.keys(), ...this.operations.keys()])].map(
        (userId) => this.cancel(userId),
      ),
    );
    await Promise.all([...this.logins.values()].map((login) => login.done));
  }
}
