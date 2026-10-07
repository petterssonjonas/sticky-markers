import { test, expect } from "@playwright/test";
test("collection search, edit, save, close and reopen", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your notes, a little closer." }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Search notes" }).fill("Garden");
  await expect(page.locator(".note-card")).toHaveCount(1);
  await page.locator(".note-card").click();
  await expect(page.locator(".markdown-body table")).toBeVisible();
  await page.getByRole("button", { name: "Note menu", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\n\nA safely kept thought.");
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close note to collection" }).click();
  await expect(page.locator(".collection")).toBeVisible();
  await page.getByRole("textbox", { name: "Search notes" }).fill("Garden");
  await page.locator(".note-card").click();
  await expect(editor).toContainText("A safely kept thought.");
});
test("palettes contain 16 colors and typography controls persist", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".note-card").first().click();
  await page.getByRole("button", { name: "Note menu", exact: true }).click();
  await expect(page.locator(".swatches button")).toHaveCount(16);
  await page.getByLabel("Color palette").selectOption("nord");
  await page.getByRole("button", { name: "Color 6", exact: true }).click();
  await page.getByLabel("Note font", { exact: true }).selectOption("mono");
  await page.reload();
  await page.getByRole("button", { name: "Note menu", exact: true }).click();
  await expect(page.getByLabel("Color palette")).toHaveValue("nord");
  await expect(page.getByLabel("Note font", { exact: true })).toHaveValue(
    "mono",
  );
});
test("Mermaid renders", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "Search notes" })
    .fill("Something to make");
  await page.locator(".note-card").click();
  await expect(page.locator(".mermaid svg")).toBeVisible({ timeout: 20000 });
});
test("settings, theme and MCP configuration are accessible", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("dialog", { name: "Settings" }).getByRole("combobox").first().selectOption("dark");
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-appearance", "dark");
  await page.getByRole("button", { name: "MCP access" }).click();
  await expect(page.locator(".config-code")).toContainText("--vault");
});
test("Markdown rendering is safe and editing preserves CRLF frontmatter", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const key = "sticky-markers-browser-demo-v1";
    // Persist the initial demo before replacing one note with this import fixture.
    const initial = {
      vaults: [{ id: "demo", name: "Fixture", path: "fixture", github: null }],
      activeVault: "demo", settings: { appearance: "light", palette: "classic", color: 0, font: "sans", fontSize: 16, mode: "view", width: 380, height: 420 },
      styles: {}, recent: [],
    };
    localStorage.setItem(key, JSON.stringify({ config: initial, files: {
      "Fixture.md": "---\r\nunknown: [1,2]\r\n---\r\n# Fixture\r\n\r\n- [x] Ready\r\n\r\n<u>Underlined</u> and ~~gone~~.\r\n\r\n$E=mc^2$\r\n\r\n<script>window.noteExecuted=true</script>\r\n<img src=x onerror=\"window.noteExecuted=true\">\r\n"
    }}));
  });
  await page.reload();
  await page.locator(".note-card").click();
  await expect(page.locator(".markdown-body u")).toHaveText("Underlined");
  await expect(page.locator(".markdown-body del")).toHaveText("gone");
  await expect(page.locator(".katex")).toBeVisible();
  await expect(page.locator(".markdown-body script")).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, "noteExecuted"))).toBeUndefined();
  await page.getByRole("button", { name: "Note menu", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\nKept.");
  await page.getByRole("button", { name: "Close note to collection" }).click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("sticky-markers-browser-demo-v1")!).files["Fixture.md"] as string);
  expect(saved.startsWith("---\r\nunknown: [1,2]\r\n---\r\n")).toBe(true);
  expect(saved.replaceAll("\r\n", "").includes("\n")).toBe(false);
  expect(saved.endsWith("\r\nKept.")).toBe(true);
});
test("updater settings explain desktop installation and automatic checks", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Updates", exact: true }).click();
  await expect(page.getByText("Installed version 0.1.0")).toBeVisible();
  await page.getByRole("button", { name: "Check for updates", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("desktop app");
  await page.getByRole("checkbox", { name: /Automatic update checks/ }).uncheck();
  await page.getByRole("button", { name: "Save update preferences" }).click();
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Updates", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /Automatic update checks/ })).not.toBeChecked();
});
