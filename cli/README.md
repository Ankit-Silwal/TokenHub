# TokenHub CLI

An installable terminal client for TokenHub borrowers. Requires Node.js 22.12 or newer and a running TokenHub deployment.

Install from the repository:

```sh
npm install -g github:Ankit-Silwal/TokenHub
tokenhub login --server https://your-tokenhub-server.example --email you@example.com
tokenhub offers
tokenhub request <offer-id> "Help with my project"
# Once the lender approves:
tokenhub redeem <pass-id>
tokenhub status
tokenhub
```

For a local server, use `http://localhost:3000`. Register your TokenHub account in the web app first. The password prompt is hidden; passwords are never saved. Automated environments may supply `TOKENHUB_PASSWORD` for login. Sessions expire after seven days; `tokenhub logout` revokes the current CLI session.

Run `tokenhub` in your project directory to open the coding agent. It can list/read project files, propose file writes or exact text replacements, and run commands. Every write and command shows a preview and requires an explicit `y` or `yes`; noninteractive sessions deny these operations. Reads happen automatically, and file contents/tool results are sent to the TokenHub server and stored in your conversation. Use `tokenhub chat` for conversation without local tools.

```sh
tokenhub agent --cwd ./my-project "Find and fix the failing test"
tokenhub agent --max-turns 6 "Explain how this project starts"
tokenhub chat "Explain this error"
```

Run `tokenhub --help` for all commands. `/status`, `/usage`, `/passes`, `/use <id>`, `/new`, `/chat`, `/agent`, and `/exit` are available inside the interactive terminal. `tokenhub sessions` and `tokenhub resume <id>` restore server-side conversations. Resume an agent from its original project directory (or supply `--cwd`). `status --json` and `usage --json` provide machine-readable data.

The default task limit is 12 model turns, configurable from 1 to 30. The agent stops on completion, cancellation, exhausted/expired/revoked access, invalid model actions, or its turn limit. Every planning/tool-result turn is metered. The server's existing 48,000-character conversation limit also applies; use `/new` when full. It does not silently retry or summarize a failed generation. After an interrupted local action, inspect the workspace before asking the agent to continue.

File tools stay within the chosen project, reject links and common credential paths, and recheck files for changes after approval. Reads return up to 6,000 characters at a time. Commands use PowerShell on Windows and `/bin/sh` on macOS/Linux, start in the project directory, and time out after 60 seconds. Commands run with your OS account permissions and can access locations outside the project; approval is not an OS sandbox. Review the complete command before approving it. TokenHub session/password environment variables are not forwarded to commands. Cancellation attempts to stop the process tree; if Windows refuses tree termination, the shell is stopped and a warning is returned.

This is TokenHub's own local tool loop backed by server-side Codex inference. It does not install or launch the native Codex TUI, and does not provide Codex's full MCP/plugin/sandbox feature set. No additional server or borrower-side Codex login is needed. Demo servers return a labeled answer without exercising tools; live coding requires a connected lender.

State and the borrower session are stored in `~/.tokenhub/config.json` (override with `TOKENHUB_HOME`). On POSIX systems this file is mode 0600; on Windows it inherits your user-directory ACL. Protect this file as a credential. Lender credentials never leave the server. HTTPS is required except for loopback development servers. Redirects are rejected to avoid forwarding credentials to another origin.

Every turn uses the same allowance, expiry, revocation, and concurrency checks as web chat. Usage includes full input and output. Limits admit or reject each turn; the last admitted turn can exceed the balance. Failed upstream turns with unknown usage conservatively exhaust the pass. The CLI never automatically retries a generation.

To build a standalone package without the web/server workspaces:

```sh
npm pack ./cli
npm install -g ./tokenhub-cli-0.2.0.tgz
```

The package has no runtime dependencies. It has not been published to the npm registry.
