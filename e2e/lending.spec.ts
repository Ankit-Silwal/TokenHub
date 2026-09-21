import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
async function register(page: Page, name: string, email: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Become a lender" }).click();
  const modal = page.getByRole("dialog");
  await modal.getByLabel("Your name").fill(name);
  await modal.getByLabel("Email address").fill(email);
  await modal
    .getByLabel("Password", { exact: true })
    .fill("Test-password-123!");
  await modal.getByRole("button", { name: "Create account" }).click();
  await expect(modal).toBeHidden();
}
test("lender approves, borrower redeems, chats, reloads history and loses access after revocation", async ({
  browser,
}) => {
  const lenderContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const borrowerContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const lender = await lenderContext.newPage(),
    borrower = await borrowerContext.newPage();
  const stamp = Date.now();
  const errors: string[] = [];
  lender.on("pageerror", (e) => errors.push(e.message));
  borrower.on("pageerror", (e) => errors.push(e.message));
  await register(lender, "Alex Lender", "lender-" + stamp + "@example.com");
  await lender.getByRole("button", { name: "My lending" }).click();
  await lender.getByRole("button", { name: "Connect Codex" }).click();
  await lender.getByRole("button", { name: "Done", exact: true }).click();
  await lender
    .getByRole("button", { name: "Create offer", exact: true })
    .click();
  const form = lender.getByRole("dialog");
  await form.getByLabel("Offer title").fill("A little TypeScript help");
  await form
    .getByLabel("What can you help with?")
    .fill("Build a project, learn TypeScript, or untangle a tricky bug.");
  await form.getByLabel("Tokens per pass").fill("50000");
  await form.getByLabel("Access duration (minutes)").fill("60");
  await form.getByLabel("Available until").fill("2026-10-01T18:00");
  // Use a relative date, so this remains valid after the initial development session.
  const tomorrow = new Date(Date.now() + 86400000);
  await form
    .getByLabel("Available until")
    .fill(
      new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16),
    );
  await form.getByRole("button", { name: "Publish offer" }).click();
  await expect(form).toBeHidden();
  await register(borrower, "Sam Builder", "borrower-" + stamp + "@example.com");
  await borrower.getByRole("button", { name: "Explore access" }).click();
  await borrower
    .getByRole("button", { name: "Request access", exact: true })
    .click();
  await borrower
    .getByLabel("What are you working on?")
    .fill("I want to learn TypeScript and build a small app.");
  await borrower
    .getByRole("button", { name: "Send request", exact: true })
    .click();
  await expect(borrower.getByRole("dialog")).toBeHidden();
  await lender.reload();
  await lender.getByRole("button", { name: "My lending" }).click();
  await lender.getByRole("button", { name: "Approve", exact: true }).click();
  await lender.getByRole("button", { name: "Approve & issue code" }).click();
  await expect(lender.getByRole("dialog")).toBeHidden();
  await mkdir(".runtime/screenshots", { recursive: true });
  await lender.screenshot({
    path: ".runtime/screenshots/lending-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await borrower.reload();
  await borrower
    .getByRole("button", { name: "My access", exact: true })
    .click();
  await borrower.getByRole("button", { name: "View access code" }).click();
  await expect(borrower.getByLabel("Access code")).toHaveValue(/^TH-/);
  await borrower.getByRole("button", { name: "Activate access" }).click();
  await expect(borrower.getByRole("dialog")).toBeHidden();
  await borrower.getByRole("button", { name: "Start a conversation" }).click();
  await borrower
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Write a TypeScript greeting function.");
  await borrower.getByRole("button", { name: "Send message" }).click();
  await expect(
    borrower.getByText("Demo response", { exact: true }),
  ).toBeVisible();
  await expect(
    borrower.getByRole("button", { name: "Copy code" }),
  ).toBeVisible();
  await borrower.screenshot({
    path: ".runtime/screenshots/chat-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await borrower.reload();
  await borrower
    .getByRole("button", {
      name: "Write a TypeScript greeting function.",
      exact: true,
    })
    .click();
  await expect(
    borrower.getByText("Demo response", { exact: true }),
  ).toBeVisible();
  await lender.getByRole("button", { name: "Revoke access" }).click();
  await expect(
    lender.getByText("Access revoked.", { exact: true }),
  ).toBeVisible();
  await borrower
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("One more question");
  await borrower.getByRole("button", { name: "Send message" }).click();
  await expect(
    borrower
      .getByRole("alert")
      .filter({ hasText: /expired|revoked|Activate an access/ }),
  ).toContainText(/expired|revoked|Activate an access/);
  expect(errors).toEqual([]);
  await lenderContext.close();
  await borrowerContext.close();
});
test("landing page works on desktop and mobile without horizontal overflow", async ({
  page,
}) => {
  await mkdir(".runtime/screenshots", { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Big ideas start with a conversation." }),
  ).toBeVisible();
  await page.screenshot({
    path: ".runtime/screenshots/home-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Build something" }).click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue(/TypeScript/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".runtime/screenshots/home-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Explore access" }).click();
  await expect(
    page.getByRole("heading", { name: "A little access opens a lot." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Join TokenHub" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("device sign-in can be cancelled and retried after a server restart", async ({
  page,
}) => {
  await register(
    page,
    "Device Tester",
    "device-" + Date.now() + "@example.test",
  );
  await page.getByRole("button", { name: "My lending" }).click();
  let loginState = "pending";
  let cancelled = false;
  await page.route("**/api/connection", async (route) => {
    if (route.request().method() === "POST") loginState = "pending";
    await route.fulfill({
      json:
        loginState === "pending"
          ? {
              state: "pending",
              url: "https://auth.openai.com/codex/device",
              code: "ABCD-1234",
            }
          : { state: loginState },
    });
  });
  await page.route("**/api/connection/cancel", async (route) => {
    cancelled = true;
    await route.fulfill({ json: { ok: true } });
  });
  await page.getByRole("button", { name: "Connect Codex" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("ABCD-1234")).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "Open OpenAI sign-in" }),
  ).toHaveAttribute("href", "https://auth.openai.com/codex/device");
  await dialog.getByRole("button", { name: "Cancel sign-in" }).click();
  await expect(dialog).toBeHidden();
  expect(cancelled).toBe(true);
  await page.getByRole("button", { name: "Connect Codex" }).click();
  await expect(dialog.getByText("ABCD-1234")).toBeVisible();
  loginState = "idle";
  await expect(
    dialog.getByRole("button", { name: "Try sign-in again" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Try sign-in again" }).click();
  await expect(dialog.getByText("ABCD-1234")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel sign-in" }).click();
});
