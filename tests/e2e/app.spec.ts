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

test("blank drafts stay off disk; first save names the note and pinning survives close", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New note", exact: false }).first().click();
  await expect(page.locator(".note-window")).toBeVisible();
  await expect(page.locator(".note-drag")).toHaveText("New note");
  const files = () => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("sticky-markers-browser-demo-v1")!).files));
  expect(await files()).toHaveLength(5);
  await page.getByRole("button", { name: "Close note to collection" }).click();
  expect(await files()).toHaveLength(5);
  await page.getByRole("button", { name: "New note", exact: false }).first().click();
  const editor = page.locator(".cm-content");
  await editor.pressSequentially("## Hello world\n\nA small **thought**.");
  await expect(page.locator(".note-drag")).toHaveText("Hello_world");
  await page.getByRole("button", { name: "Pin note", exact: true }).click();
  await page.getByRole("button", { name: "Close note to collection" }).click();
  await page.locator(".tabs").getByRole("button", { name: "Pinned notes" }).click();
  await expect(page.locator(".note-card")).toHaveCount(1);
  await page.locator(".note-card").click();
  await expect(page.getByRole("button", { name: "Unpin note" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Unpin note" }).click();
  await page.getByRole("button", { name: "Close note to collection" }).click();
  await page.locator(".tabs").getByRole("button", { name: "Pinned notes" }).click();
  await expect(page.locator(".note-card")).toHaveCount(0);
});
test("Rendered mode edits source paragraphs and renders the rest without losing Markdown", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("textbox", { name: "Search notes" }).fill("Garden");
  await page.locator(".note-card").click();
  await expect(page.locator(".markdown-body table")).toBeVisible();
  await page.locator(".live-preview-block").filter({ hasText: "Remember: growth" }).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\n\n## A new heading\n\nA new paragraph");
  await page.getByRole("button", { name: "Note menu", exact: true }).click();
  await expect(page.locator(".markdown-body h2")).toHaveText("A new heading");
  await expect(page.getByRole("button", { name: "Rendered mode", exact: true })).toHaveClass(/active/);
  await page.getByRole("button", { name: "Rendered mode", exact: true }).click();
  await page.getByRole("button", { name: "Insert heading", exact: true }).click();
  await page.getByRole("button", { name: "Heading 3", exact: false }).click();
  await page.getByRole("button", { name: "Close note to collection" }).click();
  const content = await page.evaluate(() => JSON.parse(localStorage.getItem("sticky-markers-browser-demo-v1")!).files["Garden notes.md"] as string);
  expect(content).toContain("## A new heading");
  expect(content).toContain("### A new paragraph");
  expect(content).toContain("| Basil | Move to the window |");
  expect(errors).toEqual([]);
});
test("small windows move save status into the menu and have no footer", async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 440 });
  await page.goto("/?vault=demo&note=Garden%20notes.md");
  await expect(page.locator(".note-drag")).toHaveCSS("font-size", "16px");
  await expect(page.locator(".note-footer")).toHaveCount(0);
  await expect(page.locator(".note-save-status")).toBeHidden();
  await page.getByRole("button", { name: "Note menu", exact: true }).click();
  await expect(page.locator(".menu-save-status")).toHaveText("Saved locally");
  await expect(page.locator(".menu-vault")).toHaveText("Everyday notes");
  await expect(page.getByLabel("Note font").locator("optgroup option")).toHaveCount(3);
  expect(await page.locator(".note-header").evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
});

test("arbitrary text notes open as source and rendered card links cannot overflow", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New note", exact: false }).first().click();
  await page.getByRole("button", { name: "Close note to collection" }).click();
  await page.evaluate(() => {
    const key = "sticky-markers-browser-demo-v1", d = JSON.parse(localStorage.getItem(key)!);
    d.files = { "settings.toml": "# Configuration\nvalue = true\n", "Image.md": `![](https://example.invalid/${"a".repeat(3000)})\n\n**A visible preview**\n\n[Clickable text](https://example.invalid/${"b".repeat(1000)})` };
    localStorage.setItem(key, JSON.stringify(d));
  });
  await page.reload();
  await expect(page.locator(".card-preview strong")).toHaveText("A visible preview");
  for (const card of await page.locator(".note-card").all()) expect(await card.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await page.getByRole("textbox", { name: "Search notes" }).fill("settings.toml");
  await page.locator(".note-card").click();
  await expect(page.locator(".cm-content")).toContainText("value = true");
  await expect(page.locator(".cm-gutters")).toBeVisible();
  await expect(page.locator(".markdown-body")).toHaveCount(0);
  await page.getByRole("button", { name: "Note menu", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveClass(/active/);
});
