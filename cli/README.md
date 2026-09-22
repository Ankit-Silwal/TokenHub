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
tokenhub chat
```

For a local server, use `http://localhost:3000`. Register your TokenHub account in the web app first. The password prompt is hidden; passwords are never saved. Automated environments may supply `TOKENHUB_PASSWORD` for login. Sessions expire after seven days; `tokenhub logout` revokes the current CLI session.

Run `tokenhub --help` for all commands. `/status`, `/usage`, `/passes`, `/use <id>`, `/new`, and `/exit` are available inside the interactive terminal. `tokenhub sessions` and `tokenhub resume <id>` restore server-side conversations. `status --json` and `usage --json` provide machine-readable data.

State and the borrower session are stored in `~/.tokenhub/config.json` (override with `TOKENHUB_HOME`). On POSIX systems this file is mode 0600; on Windows it inherits your user-directory ACL. Protect this file as a credential. Lender credentials never leave the server. HTTPS is required except for loopback development servers. Redirects are rejected to avoid forwarding credentials to another origin.

Every turn uses the same allowance, expiry, revocation, and concurrency checks as web chat. Usage includes full input and output. Limits admit or reject each turn; the last admitted turn can exceed the balance. Failed upstream turns with unknown usage conservatively exhaust the pass. The CLI never automatically retries a generation.

To build a standalone package without the web/server workspaces:

```sh
npm pack ./cli
npm install -g ./tokenhub-cli-0.2.0.tgz
```

The package has no runtime dependencies. It has not been published to the npm registry.
