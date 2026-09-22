import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { Config, Client, serverUrl, display, printUsage } from "./client.mjs";

const help = `TokenHub — terminal access to your borrowed AI allowance

  tokenhub login --server <URL> [--email <email>]
  tokenhub logout
  tokenhub status [--json]      Account, provider, passes and remaining tokens
  tokenhub usage [--json]       Usage totals and recent request events
  tokenhub offers              Find available lending offers
  tokenhub request <offer-id> <note>
  tokenhub passes              List your passes
  tokenhub redeem <pass-id|code>  Activate an approved pass
  tokenhub use <pass-id>        Select an active pass
  tokenhub chat [prompt]        Chat; omit prompt for an interactive session
  tokenhub sessions            List saved conversations
  tokenhub resume <id>         Continue a conversation
  tokenhub                     Open the interactive terminal

Interactive commands: /help /status /usage /passes /use <id> /new /exit
Node.js 22.12+. Login uses your TokenHub account, not lender credentials.`;

export async function ask(label, secret = false) {
  if (!process.stdin.isTTY)
    throw new Error("This action requires an interactive terminal.");
  process.stdout.write(label);
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!secret) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  rl.on("SIGINT", () => rl.close());
  try {
    return await rl.question("");
  } finally {
    rl.close();
    if (secret) process.stdout.write("\n");
  }
}
export async function selectedGrant(client, config) {
  const { grants } = await client.request("/cli/usage");
  const available = grants.filter((g) => g.effective_status === "active");
  let grant = available.find((g) => g.id === config.data.grantId);
  if (!grant && !config.data.grantId && available.length === 1) {
    grant = available[0];
    config.data.grantId = grant.id;
    await config.save();
  }
  if (!grant)
    throw new Error(
      "Select an active pass with tokenhub use <id>. Run tokenhub passes to view limits.",
    );
  return grant;
}
export async function sendMessage(client, config, content, signal) {
  if (!content.trim() || content.length > 12000)
    throw new Error("Messages must contain 1–12,000 characters.");
  await selectedGrant(client, config);
  if (!config.data.conversationId) {
    const conversation = await client.request(
      "/conversations",
      { grantId: config.data.grantId },
      { signal },
    );
    config.data.conversationId = conversation.id;
    await config.save();
  }
  return client.request(
    `/conversations/${encodeURIComponent(config.data.conversationId)}/messages`,
    { content },
    { signal },
  );
}
export async function main(args) {
  if (args.includes("--help") || args[0] === "help") {
    console.log(help);
    return;
  }
  if (args[0] === "--version") {
    console.log("0.2.0");
    return;
  }
  const config = await new Config().load();
  const client = new Client(config);
  const [command = "chat", ...rest] = args;
  const take = (key) => {
    const at = rest.indexOf(key);
    return at < 0 ? undefined : rest[at + 1];
  };
  const usage = async (json) => {
    const data = await client.request("/cli/usage");
    if (json) console.log(JSON.stringify(data, null, 2));
    else printUsage(data, config.data.grantId);
    return data;
  };
  const select = async (id) => {
    const data = await client.request("/cli/usage");
    if (
      !data.grants.some((g) => g.id === id && g.effective_status === "active")
    )
      throw new Error("That pass is not active or has no tokens remaining.");
    config.data.grantId = id;
    delete config.data.conversationId;
    await config.save();
    console.log(`Selected pass ${id}.`);
  };
  if (command === "login") {
    const server = serverUrl(
      take("--server") ||
        config.data.server ||
        process.env.TOKENHUB_SERVER ||
        "http://localhost:3000",
    );
    const email = take("--email") || (await ask("Email: "));
    const password =
      process.env.TOKENHUB_PASSWORD || (await ask("Password: ", true));
    const temporary = new Client({ data: { server } });
    const login = await temporary.request(
      "/cli/login",
      { email, password },
      { anonymous: true },
    );
    config.data = {
      server,
      token: login.token,
      user: login.user,
      expiresAt: login.expiresAt,
    };
    await config.save();
    console.log(
      `Signed in as ${display(login.user.email)}. Session expires ${login.expiresAt}.`,
    );
    return;
  }
  if (command === "logout") {
    try {
      await client.request("/cli/logout", {});
    } catch (error) {
      if (error.status !== 401) throw error;
    }
    config.data = { server: config.data.server };
    await config.save();
    console.log("Signed out.");
    return;
  }
  if (command === "status") {
    const me = await client.request("/me");
    if (rest.includes("--json"))
      console.log(
        JSON.stringify(
          {
            ...me,
            ...(await client.request("/cli/usage")),
            selectedPass: config.data.grantId,
            conversationId: config.data.conversationId,
          },
          null,
          2,
        ),
      );
    else {
      console.log(
        `${display(me.user.name)} <${display(me.user.email)}> | ${config.data.server}`,
      );
      await usage(false);
    }
    return;
  }
  if (command === "usage" || command === "passes") {
    const data = await usage(rest.includes("--json"));
    if (command === "usage" && !rest.includes("--json"))
      for (const event of data.events)
        console.log(
          `${event.created_at} | ${event.status} | ${event.tokens} confirmed tokens | ${event.grant_id}`,
        );
    return;
  }
  if (command === "offers") {
    for (const offer of await client.request("/offers"))
      console.log(
        `${offer.id}  ${display(offer.title)} | ${offer.token_limit} tokens | ${offer.duration_minutes} minutes\n  ${display(offer.description)} | ${offer.request_status || "available"}`,
      );
    return;
  }
  if (command === "request") {
    if (!rest[0] || !rest[1])
      throw new Error("Usage: tokenhub request <offer-id> <note>");
    const grant = await client.request(
      `/offers/${encodeURIComponent(rest[0])}/request`,
      { note: rest.slice(1).join(" ") },
    );
    console.log(
      `Requested pass ${grant.id}. After approval: tokenhub redeem ${grant.id}`,
    );
    return;
  }
  if (command === "redeem") {
    if (!rest[0]) throw new Error("Usage: tokenhub redeem <pass-id|code>");
    const code = rest[0].startsWith("TH-")
      ? rest[0]
      : (await client.request(`/grants/${encodeURIComponent(rest[0])}/code`))
          .code;
    await select((await client.request("/redeem", { code })).id);
    return;
  }
  if (command === "use") {
    await select(rest[0]);
    return;
  }
  if (command === "sessions") {
    for (const c of await client.request("/conversations"))
      console.log(`${c.id} | ${display(c.title)} | pass ${c.grant_id}`);
    return;
  }
  if (command === "resume") {
    const c = (await client.request("/conversations")).find(
      (c) => c.id === rest[0],
    );
    if (!c) throw new Error("Conversation not found. Run tokenhub sessions.");
    await select(c.grant_id);
    config.data.conversationId = c.id;
    await config.save();
    for (const message of await client.request(
      `/conversations/${c.id}/messages`,
    ))
      console.log(`${message.role}: ${display(message.content)}`);
  } else if (command !== "chat")
    throw new Error(`Unknown command: ${command}. Run tokenhub --help.`);
  const turn = async (prompt) => {
    console.error("Thinking…");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    try {
      const reply = await sendMessage(
        client,
        config,
        prompt,
        controller.signal,
      );
      console.log(display(reply.content));
      console.error(`\n${reply.tokens} tokens this turn.`);
    } finally {
      process.off("SIGINT", cancel);
    }
  };
  if (command === "chat" && rest.length) {
    await turn(rest.join(" "));
    return;
  }
  if (!process.stdin.isTTY)
    throw new Error(
      "Use tokenhub chat <prompt> outside an interactive terminal.",
    );
  console.log("TokenHub | /help for commands | Ctrl+C to cancel\n");
  await usage(false);
  while (true) {
    let prompt;
    try {
      prompt = (await ask("you › ")).trim();
    } catch {
      break;
    }
    if (!prompt) continue;
    if (prompt === "/exit" || prompt === "/quit") break;
    try {
      if (prompt === "/help") console.log(help);
      else if (["/status", "/usage", "/passes"].includes(prompt))
        await usage(false);
      else if (prompt.startsWith("/use ")) await select(prompt.slice(5).trim());
      else if (prompt === "/new") {
        delete config.data.conversationId;
        await config.save();
        console.log("Started a fresh conversation.");
      } else if (prompt.startsWith("/"))
        console.log("Unknown command. Use /help.");
      else await turn(prompt);
    } catch (error) {
      console.error(`TokenHub: ${error.message}`);
    }
  }
}
