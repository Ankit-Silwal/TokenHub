import "dotenv/config";
import { connectDb, migrate } from "./db.js";
import { createApp } from "./app.js";
import { codexProvider, demoProvider } from "./provider.js";
const db = await connectDb();
await migrate(db);
const demo = process.env.AI_PROVIDER === "demo";
if (process.env.NODE_ENV === "production" && demo)
  throw new Error("Demo provider cannot run in production.");
const { app, close } = createApp({
  db,
  provider: demo ? demoProvider : codexProvider,
  encryptionKey: process.env.ENCRYPTION_KEY || "",
  origin: process.env.APP_ORIGIN || "http://localhost:3000",
  demo,
  production: process.env.NODE_ENV === "production",
});
const server = app.listen(
  Number(process.env.API_PORT || 3001),
  "127.0.0.1",
  () =>
    console.log(
      "TokenHub API ready on http://127.0.0.1:" +
        (process.env.API_PORT || 3001),
    ),
);
async function shutdown() {
  await close();
  server.close();
  await db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
