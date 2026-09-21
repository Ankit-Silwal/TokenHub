import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  timeout: 60000,
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: "http://localhost:3100",
    channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3100",
    timeout: 60000,
    reuseExistingServer: false,
    env: {
      TOKENHUB_E2E: "true",
      PORT: "3100",
      API_PORT: "3101",
      APP_ORIGIN: "http://localhost:3100",
      AI_PROVIDER: "demo",
      EMBEDDED_DB: "true",
      EMBEDDED_DB_PATH: ".runtime/e2e-" + Date.now(),
      ENCRYPTION_KEY: "ab".repeat(32),
    },
  },
});
