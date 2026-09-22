# TokenHub

A permission-based AI lending app with a Next.js frontend, a Node.js/TypeScript backend, PostgreSQL, and Codex CLI. Borrowers get a TokenHub access code; they never receive a lender's Codex credentials.

## Project layout

- **frontend/** — Next.js App Router, React, responsive chat, Markdown/code blocks, access discovery, lending dashboard, approvals, and passes.
- **backend/** — Express API, PostgreSQL schema, account/session authentication, encrypted Codex connections, usage accounting, and integration tests.
- **e2e/** — Playwright browser tests.
- **compose.yaml** — PostgreSQL 17 for local development.

Redis is unnecessary here: PostgreSQL stores sessions, rate limits, grants, and atomic request leases.

## Install the terminal client

```sh
npm install -g https://github.com/Ankit-Silwal/TokenHub/archive/refs/heads/main.tar.gz
tokenhub login --server https://your-tokenhub-server.example
tokenhub passes
tokenhub redeem <approved-pass-id>
tokenhub status
tokenhub
```

The CLI uses your TokenHub account and the same pass allowance as the website. Run `tokenhub` inside a project to open the coding agent: it reads files, proposes edits, and runs commands after terminal approval. `tokenhub chat` provides plain chat. Use `http://localhost:3000` for local development. `tokenhub usage --json` exposes usage events and remaining tokens; `tokenhub --help` lists access requests, pass selection, and conversation commands. See [the CLI guide](cli/README.md) for local tool permissions, session storage, and packaging. The CLI is installable from GitHub; it is not published on npm yet.

The existing API serves both web and CLI users; no extra server is required. Restart the backend after upgrading so startup migrations create CLI sessions and conversation modes. The coding agent uses TokenHub's local tool loop, not the native Codex TUI or its complete plugin/MCP feature set. Each planning and tool-result turn passes through the same server usage checks. Automated tests use an injected provider; a real lender connection is needed to verify live model behavior.

## Start locally

Use Node.js 22.12 or newer.

1. Run `npm install`.
2. Copy `backend/.env.example` to `backend/.env` (PowerShell: `Copy-Item backend/.env.example backend/.env`).
3. Generate the encryption key with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Put it in `ENCRYPTION_KEY`.
4. Run `docker compose up -d`, or point DATABASE_URL at an existing PostgreSQL database.
5. Run `npm run db:migrate`.
6. Run `npm run dev` and open http://localhost:3000.

The frontend runs on port 3000; the private API binds to 127.0.0.1:3001. Next.js proxies /api to the backend. APP_ORIGIN must exactly match the browser origin, including port. Restart the frontend if API_PORT changes.

**Without Docker:** set EMBEDDED_DB=true. Development then uses persistent PGlite, PostgreSQL compiled to WASM, in backend/.runtime/postgres. Production refuses this mode and uses the pg driver.

**Without a Codex login:** set AI_PROVIDER=demo. Demo replies are explicitly labeled, have synthetic usage, and do not call OpenAI. Before switching an existing demo installation to codex, disconnect its demo connections, restart with AI_PROVIDER=codex, and connect real accounts. Prefer a separate database for demo and live environments.

## How lending works

1. Register a lender account and open **My lending → Connect Codex**.
2. Open the displayed OpenAI sign-in link and enter the device code. Device-code login must be enabled in the account's ChatGPT security settings. Sign-in takes place at OpenAI; TokenHub does not collect ChatGPT passwords.
3. Publish an offer with a token allowance **per borrower**, access duration, and final availability date.
4. A different registered user requests access with a short note.
5. The lender approves or declines. On approval, they can reduce the allowance and duration.
6. The approved borrower retrieves a random, account-bound code from **My access** and redeems it once.
7. The borrower chooses the active pass and chats. Messages and generated code are returned as Markdown; generated code is not run.
8. The lender can revoke a pass at any time. Closing an offer stops new requests and approvals but preserves existing passes. Disconnecting a Codex connection revokes all its passes.

Time starts **at approval**, not redemption, and cannot run beyond the offer's availability date. A user can request each offer once. For a replacement pass, the lender publishes a new offer.

Lenders can see request notes, grant status, and usage. Conversation endpoints only authorize the borrower; the database operator can access stored messages. Conversation text is stored in PostgreSQL without application-level encryption.

## Codex integration and limits

This app invokes the pinned **Codex CLI 0.155.1**, not the ChatGPT/Responses API. Each lender's login is encrypted using AES-256-GCM in PostgreSQL. A turn uses a temporary, separate CODEX_HOME and an empty working directory. Refreshed credentials are written back encrypted, and temporary files are removed afterward.

The native binary is invoked directly so cancellation terminates Codex itself on Windows as well as Linux/macOS. The process receives an allowlisted environment without the database password, encryption key, or API keys. It ignores user configuration, uses a read-only sandbox, and disables shell, browser, image, connector, plugin, multi-agent, and related capabilities. Chat mode requests a text answer; agent mode requests a JSON action proposal that only the borrower's CLI can execute locally. Unexpected native action events fail closed in both modes. No resumable shared Codex thread is exposed: each request receives only that borrower's stored history.

**Token budgets are admission limits, not exact provider-side spending caps.** Codex reports input/output usage after a turn. TokenHub counts full input plus output, including cached input as part of input; the final admitted response may exceed the remaining allowance. All later messages are blocked. No unsupported max-output setting or token estimate is presented as a hard provider limit.

A request has a 120-second timeout. Grant expiry cancels at the deadline; revocation is checked every 500 ms and again before saving a reply. Cancellation cannot undo work already performed by the upstream provider.

Requests hold atomic database leases on both the grant and lender connection, preventing parallel consumption and refresh-token races. If a CLI request fails or is interrupted without confirmed usage, the remaining pass allowance is consumed conservatively. If the server crashes, an expired three-minute lease also locks that pass on its next attempt. This prevents silent retries against an unknown balance. Failed turns remain in usage_events.

## Verification

```sh
npm run check
npm test
npm run build
npm run test:e2e
```

Backend access tests use a fresh in-memory PostgreSQL engine and an injected test provider. Set TEST_DATABASE_URL to run the same suite against PostgreSQL; each run creates and drops only its own randomly named test schema. CI runs both variants. CLI transport tests launch child processes to verify event parsing, bounded output, cancellation, credential refresh persistence, and temporary-file cleanup. They exercise approval, account isolation, encrypted credential storage, one-time redemption, expiry, exhaustion, concurrent requests, revocation while generating, unknown-usage failures, and stale leases.

Browser tests run isolated demo servers on ports 3100/3101 with a fresh development database and a separate frontend/.next-test build directory. They use local Chrome by default; set PLAYWRIGHT_CHANNEL=msedge for Edge, or install Chrome in CI. They verify registration, offers, approval, redemption, code output, persistent chat history, revocation, mobile navigation, and device sign-in cancellation/retry. Screenshots are written to .runtime/screenshots.

The test suite does **not** use a real ChatGPT login or prove live Codex generation. Complete device sign-in and send a live message to verify your deployment's account access.

## Optional live Codex check

This check is explicit and separate from automated tests. It makes **two short real Codex requests**, so it consumes the connected lender's usage.

1. Start the app in live mode (AI_PROVIDER=codex), connect your lender account, and publish a small test offer.
2. Run `npm run test:live`. It creates a local test borrower and requests access. If several offers are available, pass the chosen offer ID: `npm run test:live -- <offer-id>`.
3. Approve **TokenHub live test** in **My lending**. Give it enough room for Codex's input/context overhead.
4. Run `npm run test:live` again. It redeems the account-bound code, checks two real replies and conversation context, then verifies persisted history and recorded usage.
5. Revoke the test pass when finished.

The command only targets http://localhost:3000. It refuses demo mode and stores its test session in ignored .runtime/live-check.json, never in Git or console output. It does not reuse your personal login session. A completed check will not issue more requests if run again; an interrupted request is not automatically retried because its usage may be unknown.

Device sign-in can now be cancelled or retried from the connection dialog. Pending sign-ins are serialized per lender. Disconnect waits for a completing sign-in before removing credentials, and application shutdown cancels active CLI work while the database is still available for accounting and cleanup.

## Deployment boundaries

- Run `npm run build`, then start both workspaces with `npm start`. Set NODE_ENV=production, AI_PROVIDER=codex, APP_ORIGIN to your HTTPS origin, DATABASE_URL, and a persistent ENCRYPTION_KEY in the backend environment.
- Use one API instance initially. Device login processes live in that instance's memory. Database leases protect chat concurrency, but scaling device-login polling needs shared job routing.
- Place the Next.js server behind HTTPS. Keep the API private. Secure cookies are enabled in production and writes require an exact Origin match.
- Run the backend under a dedicated unprivileged OS account/container with no unrelated host data. CLI feature flags and text instructions are not a replacement for OS isolation.
- Back up PostgreSQL and the encryption key separately. Losing the key makes existing encrypted credentials unusable; changing it requires reconnecting lenders.
- This initial application has no email verification, password reset, billing, streaming token delivery, or admin recovery UI. Replies appear when the CLI completes its turn.
- Default local PostgreSQL credentials in compose.yaml are for development. Use managed secrets in a deployment.

## Official integration references

- [Codex non-interactive mode and JSON usage events](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codex authentication and device-code login](https://learn.chatgpt.com/docs/auth)
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
