// Explicit live integration check. Never runs in npm test or CI.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const origin = "http://localhost:3000";
const statePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../.runtime/live-check.json",
);
let state = {};
try {
  state = JSON.parse(await readFile(statePath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
async function save() {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}
async function api(path, body) {
  const response = await fetch(origin + "/api" + path, {
    method: body ? "POST" : "GET",
    headers: {
      Origin: origin,
      ...(state.cookie ? { Cookie: state.cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(130000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "Request failed (" + response.status + ")");
  const cookie = response.headers.get("set-cookie");
  if (cookie) {
    state.cookie = cookie.split(";")[0];
    await save();
  }
  return data;
}
async function main() {
  if ((await api("/health")).provider !== "codex")
    throw new Error("Live check requires AI_PROVIDER=codex.");
  if (state.phase === "done") {
    console.log("Live check already passed. No additional tokens used.");
    return;
  }
  if (state.phase === "sending")
    throw new Error(
      "A previous live request has an uncertain result. Inspect the test conversation before running another request.",
    );
  if (!state.cookie) {
    const suffix = randomBytes(8).toString("hex");
    await api("/auth/register", {
      name: "TokenHub live test",
      email: "live-check-" + suffix + "@example.test",
      password: randomBytes(32).toString("base64url"),
    });
    state.phase = "registered";
    await save();
    console.log(
      "Created a local test borrower. Session saved only in ignored .runtime/.",
    );
  }
  const me = await api("/me");
  if (!state.grantId) {
    const offers = (await api("/offers")).filter(
      (offer) => offer.lender_id !== me.user.id,
    );
    const specified = process.argv[2];
    const offer = specified
      ? offers.find((offer) => offer.id === specified)
      : offers.length === 1
        ? offers[0]
        : undefined;
    if (!offer) {
      console.log(
        offers.length
          ? "Choose one offer: npm run test:live -- <offer-id>"
          : "Waiting for a lender to publish a test offer.",
      );
      for (const item of offers) console.log(item.id + "  " + item.title);
      return;
    }
    if (offer.request_status) {
      const grants = await api("/grants");
      state.grantId = grants.find((grant) => grant.offer_id === offer.id)?.id;
      if (!state.grantId)
        throw new Error("Request exists but its grant could not be found.");
    } else {
      const grant = await api("/offers/" + offer.id + "/request", {
        note: "Live integration check: two short text replies to verify Codex routing, conversation context, and recorded token usage.",
      });
      state.grantId = grant.id;
    }
    state.phase = "requested";
    await save();
    console.log(
      "Requested access. Approve 'TokenHub live test' in My lending, then run this command again.",
    );
    return;
  }
  const grant = (await api("/grants")).find(
    (grant) => grant.id === state.grantId,
  );
  if (!grant) throw new Error("Test grant no longer exists.");
  if (grant.status === "pending") {
    console.log("Waiting for lender approval in My lending.");
    return;
  }
  if (grant.status === "approved") {
    const { code } = await api("/grants/" + grant.id + "/code");
    await api("/redeem", { code });
  } else if (grant.status !== "active")
    throw new Error("Test pass is " + grant.status);
  if (!state.conversationId) {
    const conversation = await api("/conversations", { grantId: grant.id });
    state.conversationId = conversation.id;
    state.phase = "ready";
    await save();
  }
  const prompts = [
    "Reply with exactly TOKENHUB_OK. Do not use any tools.",
    "What exact marker did I ask you to reply with in my previous message? Reply only with that marker. Do not use tools.",
  ];
  state.turns ??= [];
  for (let turn = state.turns.length; turn < prompts.length; turn++) {
    state.phase = "sending";
    await save(); // Never automatically repeat a possibly billable request.
    const reply = await api(
      "/conversations/" + state.conversationId + "/messages",
      { content: prompts[turn] },
    );
    state.turns.push({ text: reply.content, tokens: reply.tokens });
    await save();
    if (reply.content.trim() !== "TOKENHUB_OK")
      throw new Error(
        "Unexpected live response. Inspect the saved test result; no automatic retry will be made.",
      );
    state.phase = "ready";
    await save();
    console.log(
      "Live turn " +
        (turn + 1) +
        " passed; reported usage: " +
        reply.tokens +
        " tokens.",
    );
  }
  const history = await api(
    "/conversations/" + state.conversationId + "/messages",
  );
  const updated = (await api("/grants")).find((item) => item.id === grant.id);
  const tokens = state.turns.reduce((total, item) => total + item.tokens, 0);
  if (history.length !== 4 || updated.used_tokens !== tokens)
    throw new Error(
      "History or usage accounting did not match the live responses.",
    );
  state.phase = "done";
  await save();
  console.log(
    "PASS: real Codex replies, conversation context, persistent history, and " +
      tokens +
      " accounted tokens.",
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
