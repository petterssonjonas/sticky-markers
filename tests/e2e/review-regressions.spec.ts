import { test, expect, type Page } from "@playwright/test";

const key = "sticky-markers-browser-demo-v1";
async function seed(page: Page) {
  await page.goto("/");
  await page.evaluate(async (key) => {
    const modulePath = "/src/api.ts";
    const { call } = await import(modulePath);
    const config = await call("bootstrap");
    config.settings.mode = "edit";
    config.settings.toolbarPins = [];
    localStorage.setItem(key, JSON.stringify({ config, files: { "Race.md": "original A" } }));
  }, key);
}

test("an obsolete poll cannot roll back text after a successful save", async ({ page }) => {
  await seed(page);
  await page.goto("/?vault=demo&note=Race.md");
  await expect(page.locator(".cm-content")).toHaveText("original A");
  await page.evaluate(() => {
    let once = true;
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (...args) => {
      const result = await digest(...args);
      if (!once) return result;
      once = false;
      return new Promise<ArrayBuffer>((resolve) => {
        (window as any).releaseOldPoll = () => resolve(result);
      });
    };
  });
  await page.waitForFunction(() => typeof (window as any).releaseOldPoll === "function");
  await page.locator(".cm-content").press("Control+End");
  await page.keyboard.type(" plus saved B");
  await page.keyboard.press("Control+s");
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).files["Race.md"], key))
    .toBe("original A plus saved B");
  await page.evaluate(() => (window as any).releaseOldPoll());
  // Let both the held response and a subsequent poll complete.
  await page.waitForTimeout(2800);
  await expect(page.locator(".cm-content")).toHaveText("original A plus saved B");
  await page.keyboard.type(" and C");
  await page.keyboard.press("Control+s");
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).files["Race.md"], key))
    .toBe("original A plus saved B and C");
});

test("saving edited settings preserves newer editor preferences from another note", async ({ page }) => {
  await seed(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Default width" }).fill("420");
  await page.evaluate(async () => {
    const modulePath = "/src/api.ts";
    const { call } = await import(modulePath);
    await call("editor_preferences", { mode: "view", toolbarPins: ["code"] });
  });
  await page.getByRole("button", { name: "Save preferences", exact: true }).click();
  await expect(page.getByText("Preferences saved.", { exact: true })).toBeVisible();
  const settings = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).config.settings, key);
  expect(settings.width).toBe(420);
  expect(settings.mode).toBe("view");
  expect(settings.toolbarPins).toEqual(["code"]);
});

test("each managed vault has accessible sync controls even when an unmanaged vault is active", async ({ page }) => {
  await seed(page);
  await page.evaluate((key) => {
    const d = JSON.parse(localStorage.getItem(key)!);
    d.config.vaults.push(
      { id: "managed1", name: "Managed One", path: "one", github: { repository: "owner/one", frequencyMinutes: 12, onExit: false, paused: false, baseline: {}, conflicts: [] } },
      { id: "managed2", name: "Managed Two", path: "two", github: { repository: "owner/two", frequencyMinutes: 35, onExit: true, paused: true, baseline: {}, conflicts: [] } },
    );
    d.config.activeVault = "demo";
    d.vaultFiles = { managed1: {}, managed2: {} };
    localStorage.setItem(key, JSON.stringify(d));
  }, key);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Vaults & GitHub", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sync · Managed One" })).toBeVisible();
  await expect(page.locator(".sync-options input[type=number]")).toHaveValue("12");
  await page.getByRole("combobox", { name: "GitHub vault", exact: true }).selectOption("managed2");
  await expect(page.getByRole("heading", { name: "Sync · Managed Two" })).toBeVisible();
  await expect(page.locator(".sync-options input[type=number]")).toHaveValue("35");
  await expect(page.getByRole("checkbox", { name: "Pause scheduled sync" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Sync on exit" })).toBeChecked();
});

test("already-saved appearance and line numbers are not reapplied by an unrelated preferences save", async ({ page }) => {
  await seed(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel(/^Appearance/).selectOption("dark");
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).config.settings.appearance, key))
    .toBe("dark");
  await page.getByRole("checkbox", { name: /^Line numbers in Edit mode/ }).uncheck();
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).config.settings.lineNumbers, key))
    .toBe(false);
  await page.evaluate(async () => {
    const modulePath = "/src/api.ts";
    const { call } = await import(modulePath);
    await call("set_appearance", { appearance: "light" });
    await call("editor_preferences", { lineNumbers: true });
  });
  await page.getByRole("spinbutton", { name: "Default width" }).fill("425");
  await page.getByRole("button", { name: "Save preferences", exact: true }).click();
  await expect(page.getByText("Preferences saved.", { exact: true })).toBeVisible();
  const settings = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).config.settings, key);
  expect(settings.width).toBe(425);
  expect(settings.appearance).toBe("light");
  expect(settings.lineNumbers).toBe(true);
});
