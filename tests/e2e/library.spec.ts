import { test, expect, type Page } from "@playwright/test";
const key = "sticky-markers-browser-demo-v1";
async function fixture(page: Page, count = 3) {
  await page.addInitScript(
    ({ key, count }) => {
      if (localStorage.getItem(key)) return;
      const files: Record<string, string> = {};
      for (let i = 0; i < count; i++)
        files[`Note_${String(i).padStart(4, "0")}.md`] =
          `# Note ${i}\n\n**Preview**\n\n- first\n- second`;
      localStorage.setItem(
        key,
        JSON.stringify({
          config: {
            vaults: [
              { id: "demo", name: "Primary", path: "primary", github: null },
              { id: "other", name: "Other", path: "other", github: null },
            ],
            activeVault: "demo",
            mainVault: "demo",
            settings: {
              mode: "view",
              appearance: "light",
              palette: "classic",
              color: 0,
              font: "sans",
              fontSize: 16,
              width: 380,
              height: 440,
              toolbarPins: [],
            },
            styles: {},
            recent: [],
          },
          files,
          vaultFiles: { other: { "existing.toml": "a = true" } },
        }),
      );
    },
    { key, count },
  );
  await page.goto("/");
}
test("large libraries keep closed vaults and previews lazy; menus respond promptly", async ({
  page,
}) => {
  const heavy: string[] = [];
  page.on("request", (r) => {
    if (/\/src\/(markdown|editor)|mermaid/.test(r.url())) heavy.push(r.url());
  });
  await fixture(page, 2500);
  await expect(page.locator(".collection.sidebar-only")).toBeVisible();
  await expect(
    page.locator(".collection-main,.note-card,.sidebar-note-card"),
  ).toHaveCount(0);
  expect(heavy).toEqual([]);
  const start = Date.now();
  await page.getByRole("button", { name: "Expand Primary" }).click();
  await expect(page.locator(".sidebar-note-card")).toHaveCount(80);
  console.log(
    `Large library: first 80 of 2500 names loaded in ${Date.now() - start} ms`,
  );
  await expect(page.locator(".card-preview,.markdown-body")).toHaveCount(0);
  expect(heavy).toEqual([]);
  const menuStart = Date.now();
  await page.getByRole("button", { name: "Add vault", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Open folder/vault" }),
  ).toBeVisible();
  console.log(`Vault menu visible in ${Date.now() - menuStart} ms`);
  expect(Date.now() - menuStart).toBeLessThan(1000);
  await page.getByRole("button", { name: "Close vault menu" }).click();
  await page.getByRole("button", { name: "Open notes panel" }).click();
  await expect(page.locator(".note-card").first()).toBeVisible();
  expect(await page.locator(".note-card").count()).toBeLessThan(100);
  await expect(page.locator(".card-preview strong").first()).toHaveText(
    "Preview",
  );
  await expect(page.locator(".card-bottom")).toHaveCount(0);
});
test("main vault directs new notes without a redundant footer", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "Set Other as main vault" }).click();
  await expect(
    page.getByRole("button", { name: "Set Other as main vault" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".vault-indicator")).toHaveCount(0);
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await page.locator(".cm-content").pressSequentially("New home note");
  await page.getByRole("button", { name: "Close note to collection" }).click();
  const data = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    key,
  );
  expect(data.vaultFiles.other["New_home_note.md"]).toBe("New home note");
  expect(data.files["New_home_note.md"]).toBeUndefined();
  await page.getByRole("button", { name: "Add vault", exact: true }).click();
  await expect(page.locator(".vault-menu button")).toHaveText([
    "Open folder/vault",
    "Import note(s)",
    "Create GitHub synced vault",
  ]);
});
test("Ctrl and Shift select notes; dragging opens the destination vault and moves the selection", async ({
  page,
}) => {
  await fixture(page, 5);
  await page.getByRole("button", { name: "Expand Primary" }).click();
  const rows = page
    .getByRole("listbox", { name: "Notes in Primary" })
    .getByRole("option");
  await expect(rows).toHaveCount(5);
  await rows.nth(1).click({ modifiers: ["ControlOrMeta"] });
  await rows.nth(3).click({ modifiers: ["Shift"] });
  await expect(
    page.locator('[role="option"][aria-selected="true"]'),
  ).toHaveCount(3);
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await rows.nth(2).dispatchEvent("dragstart", { dataTransfer: transfer });
  const destination = page.locator(".vault-group").filter({
    has: page.getByRole("button", { name: "Set Other as main vault" }),
  });
  await destination.dispatchEvent("dragover", { dataTransfer: transfer });
  await expect(
    page.getByRole("button", { name: "Collapse Other" }),
  ).toBeVisible();
  await destination.dispatchEvent("drop", { dataTransfer: transfer });
  await expect(
    page.getByRole("listbox", { name: "Notes in Other" }).getByRole("option"),
  ).toHaveCount(4);
  await expect(
    page.getByRole("listbox", { name: "Notes in Primary" }).getByRole("option"),
  ).toHaveCount(2);
  const data = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    key,
  );
  expect(data.vaultFiles.other["Note_0002.md"]).toContain("# Note 2");
  expect(data.files["Note_0002.md"]).toBeUndefined();
});
test("sorting applies to compact vault rows", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "Expand Primary" }).click();
  await page.getByRole("combobox", { name: "Sort notes" }).selectOption("name");
  await expect(page.locator(".sidebar-note-card")).toHaveText([
    "Note_0000.md",
    "Note_0001.md",
    "Note_0002.md",
  ]);
  await page.getByRole("combobox", { name: "Sort notes" }).selectOption("size");
  await expect(page.locator(".sidebar-note-card")).toHaveCount(3);
  await page.getByRole("combobox", { name: "Sort notes" }).selectOption("type");
  await expect(page.locator(".sidebar-note-card")).toHaveCount(3);
  await page.getByRole("textbox", { name: "Search notes" }).fill("Preview");
  await expect(page.locator(".sidebar-note-card")).toHaveCount(3);
  await page
    .getByRole("textbox", { name: "Search notes" })
    .fill("no such contents");
  await expect(page.locator(".sidebar-note-card")).toHaveCount(0);
});
test("mode and individual toolbar pins persist globally across notes", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "Expand Primary" }).click();
  await page.locator(".sidebar-note-card").first().click();
  await expect(page.locator(".format-buttons button")).toHaveCount(0);
  await page.getByRole("button", { name: "Note menu", exact: true }).click();
  await page.getByRole("button", { name: "Pin Bold to toolbar" }).click();
  await expect(page.locator(".format-buttons button")).toHaveCount(1);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: "Close note to collection" }).click();
  await page.getByRole("button", { name: "Expand Primary" }).click();
  await page.locator(".sidebar-note-card").nth(1).click();
  await expect(page.locator(".cm-gutters")).toBeVisible();
  await expect(
    page
      .locator(".format-buttons")
      .getByRole("button", { name: "Bold", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Note menu", exact: true }).click();
  await page.getByRole("button", { name: "Rendered", exact: true }).click();
  await page.getByRole("button", { name: "Close note to collection" }).click();
  await page.getByRole("button", { name: "Expand Primary" }).click();
  await page.locator(".sidebar-note-card").first().click();
  await expect(page.locator(".line-live-preview")).toBeVisible();
});
test("only the active list row reveals Markdown; row positions and table rendering stay stable", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate((key) => {
    const d = JSON.parse(localStorage.getItem(key)!);
    d.files["Rows.md"] =
      "# Header\n\n- one **bold**\n- two *italic*\n- three\n\n| A | B |\n| - | - |\n| one | two |\n\nLast";
    localStorage.setItem(key, JSON.stringify(d));
  }, key);
  await page.goto("/?vault=demo&note=Rows.md");
  const rows = page.locator(".lp-list-line");
  await expect(rows).toHaveCount(3);
  const positions = await rows.evaluateAll((list) =>
    list.map((e) => e.getBoundingClientRect().y),
  );
  await rows.nth(1).click();
  await expect(rows.nth(1)).toHaveText("- two *italic*");
  await expect(rows.nth(0)).toHaveText("• one bold");
  await expect(rows.nth(2)).toHaveText("• three");
  expect(
    await rows.evaluateAll((list) =>
      list.map((e) => e.getBoundingClientRect().y),
    ),
  ).toEqual(positions);
  await expect(page.locator(".lp-table table")).toBeVisible();
  await page.locator(".lp-table td").first().click();
  await page.getByRole("textbox", { name: "Edit table cell" }).fill("changed");
  await page.getByRole("textbox", { name: "Edit table cell" }).press("Enter");
  await expect(page.locator(".lp-table table")).toBeVisible();
  await expect(page.locator(".lp-table td").first()).toHaveText("changed");
  await page.getByRole("button", { name: "Close note to collection" }).click();
  const source = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!).files["Rows.md"],
    key,
  );
  expect(source).toContain("| changed | two |");
  expect(source).toContain("- two *italic*");
});

test("global mode changes reach other open note windows", async ({ page }) => {
  await fixture(page);
  const second = await page.context().newPage();
  await second.goto("/?vault=demo&note=Note_0001.md");
  await page.goto("/?vault=demo&note=Note_0000.md");
  await expect(second.locator(".line-live-preview")).toBeVisible();
  await page.getByRole("button", { name: "Note menu", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(second.locator(".cm-gutters")).toBeVisible();
  await page.getByRole("button", { name: "Note menu", exact: true }).click();
  await page.getByRole("button", { name: "Pin Bold to toolbar" }).click();
  await expect(
    second
      .locator(".format-buttons")
      .getByRole("button", { name: "Bold", exact: true }),
  ).toBeVisible();
  await second.close();
});
test("footnote content stays readable and reference links still work", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate((key) => {
    const d = JSON.parse(localStorage.getItem(key)!);
    d.files["Links.md"] =
      "# Links\n\n[Example][target] and a footnote[^a].\n\n[target]: https://example.invalid/docs\n\n[^a]: A **readable** explanation.\n\nLast row";
    localStorage.setItem(key, JSON.stringify(d));
  }, key);
  await page.goto("/?vault=demo&note=Links.md");
  await expect(
    page.locator(".cm-line").filter({ hasText: "A readable explanation." }),
  ).toBeVisible();
  await expect(page.locator(".lp-footnote")).toHaveText("a");
  await page
    .context()
    .route("https://example.invalid/docs", (route) =>
      route.fulfill({ contentType: "text/html", body: "Reference target" }),
    );
  const popup = page.waitForEvent("popup");
  await page.locator(".lp-link").filter({ hasText: "Example" }).click();
  const target = await popup;
  await target.waitForLoadState();
  expect(target.url()).toBe("https://example.invalid/docs");
  await target.close();
});

test("wikilinks resolve target files in a large linked library", async ({
  page,
}) => {
  await fixture(page, 250);
  await page.evaluate((key) => {
    const d = JSON.parse(localStorage.getItem(key)!);
    for (const p of Object.keys(d.files))
      d.files[p] += "\n\nSee [[Note_0001]].";
    localStorage.setItem(key, JSON.stringify(d));
  }, key);
  await page.goto("/?vault=demo&note=Note_0000.md");
  await page.locator(".lp-link").filter({ hasText: "Note_0001" }).click();
  await expect(page.locator(".note-drag")).toHaveText("Note_0001");
});

test("pinned navigation and tabs aggregate vaults while settings stays inside the pane", async ({
  page,
}) => {
  await fixture(page, 2);
  await page.evaluate((key) => {
    const d = JSON.parse(localStorage.getItem(key)!);
    d.config.styles = {
      "demo/Note_0000.md": { pinned: true },
      "other/existing.toml": { pinned: true },
    };
    localStorage.setItem(key, JSON.stringify(d));
  }, key);
  await page.reload();
  await expect(page.locator(".vault-row").first()).toContainText(
    "Pinned notes",
  );
  await page.getByRole("button", { name: "Expand Pinned notes" }).click();
  const pinned = page.getByRole("listbox", { name: "Notes in Pinned notes" });
  await expect(pinned.getByRole("option")).toHaveCount(2);
  await expect(pinned).toContainText("existing.toml");
  await expect(page.locator(".card-preview")).toHaveCount(0);
  await page.getByRole("button", { name: "Open notes panel" }).click();
  await expect(page.locator(".note-card")).toHaveCount(3);
  await page.getByRole("tab", { name: "Primary", exact: true }).click();
  await expect(page.locator(".note-card")).toHaveCount(2);
  await page.getByRole("tab", { name: "Other", exact: true }).click();
  await expect(page.locator(".note-card")).toHaveCount(1);
  await page.getByRole("tab", { name: "Pinned notes", exact: true }).click();
  await expect(page.locator(".note-card")).toHaveCount(2);
  await page.getByRole("button", { name: "Close notes panel" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator(".panel-expanded")).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Settings", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".collection-main .settings-pane")).toBeVisible();
  await expect(
    page.locator(".modal-backdrop,.main-header,.breadcrumb,.vault-indicator"),
  ).toHaveCount(0);
  await expect(page.getByText("Your notes stay plain Markdown.")).toHaveCount(
    0,
  );
  await page.getByRole("tab", { name: "All notes" }).click();
  await expect(page.locator(".settings-pane")).toHaveCount(0);
  await expect(page.locator(".note-card")).toHaveCount(3);
});

test("app and vault defaults create differently colored notes without changing existing notes", async ({
  page,
}) => {
  await fixture(page, 2);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const general = page.getByRole("region", { name: "Settings", exact: true });
  await general
    .getByRole("group", { name: "Default note color", exact: true })
    .getByRole("button", { name: "Yellow vibrant", exact: true })
    .click();
  await page.getByRole("button", { name: "Save preferences" }).click();
  await page.getByRole("button", { name: "Vaults & GitHub" }).click();
  await general
    .getByRole("group", { name: "Default color for Primary" })
    .getByRole("button", { name: "Purple pastel" })
    .click();
  await expect(
    general
      .getByRole("group", { name: "Default color for Primary" })
      .getByRole("button", { name: "Purple pastel" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await page.getByRole("button", { name: "Note menu", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Purple pastel" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".swatches button").first()).toHaveAttribute(
    "aria-label",
    "Yellow vibrant",
  );
  await expect(page.locator(".swatches button").nth(8)).toHaveAttribute(
    "aria-label",
    "Yellow pastel",
  );
  await expect(page.getByText("Classic", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Green vibrant" }).click();
  await page.locator(".cm-content").fill("A distinct color");
  await page.getByRole("button", { name: "Close note to collection" }).click();
  const second = await page.context().newPage();
  await second.goto("/?vault=demo&note=Note_0001.md");
  await page.goto("/?vault=demo&note=A_distinct_color.md");
  await page.getByRole("button", { name: "Note menu", exact: true }).click();
  await page.getByRole("button", { name: "Blue vibrant" }).click();
  await second.getByRole("button", { name: "Note menu", exact: true }).click();
  await expect(
    second.getByRole("button", { name: "Purple pastel" }),
  ).toHaveAttribute("aria-pressed", "true");
  const config = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!).config,
    key,
  );
  expect(config.settings.color).toBe(8);
  expect(config.vaults[0].defaultColor).toBe(4);
  expect(config.styles["demo/A_distinct_color.md"].color).toBe(15);
  await second.close();
});

test("compact appearance, oldest sorting and all bundled fonts work offline", async ({
  page,
}) => {
  await fixture(page);
  await expect(page.getByLabel("Sort notes").locator("option")).toHaveText([
    "Newest",
    "Oldest",
    "Name",
    "Size",
    "Type",
  ]);
  await page.getByRole("button", { name: "Expand Primary" }).click();
  await page.getByLabel("Sort notes").selectOption("oldest");
  await expect(page.locator(".sidebar-note-card").first()).toHaveText(
    "Note_0002.md",
  );
  expect(
    (await page.getByLabel("Search notes").boundingBox())!.height,
  ).toBeLessThan(28);
  expect(
    (await page.getByLabel("Sort notes").boundingBox())!.height,
  ).toBeLessThan(28);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("region", { name: "Settings", exact: true });
  const appearance = settings.getByRole("combobox").first();
  await appearance.selectOption("light");
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-appearance",
    "light",
  );
  await expect(page.locator(".sidebar")).toHaveCSS(
    "background-color",
    "rgb(231, 226, 218)",
  );
  await appearance.selectOption("dark");
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.locator(".sidebar")).toHaveCSS(
    "background-color",
    "rgb(27, 32, 27)",
  );
  await page.goto("/?vault=demo&note=Note_0000.md");
  await page.getByRole("button", { name: "Note menu", exact: true }).click();
  const fonts = page.getByLabel("Note font", { exact: true });
  await expect(fonts.locator(":scope > option").first()).toHaveText("Libron");
  for (const [id, family] of [
    ["libron", "Libron"],
    ["barlow", "Barlow"],
    ["noto-sans", "Noto Sans"],
  ]) {
    await fonts.selectOption(id);
    await page.evaluate(async (family) => {
      const faces = await document.fonts.load(`16px "${family}"`);
      if (!faces.length || faces.some((face) => face.status !== "loaded"))
        throw new Error(`Missing bundled font ${family}`);
    }, family);
  }
  await expect(fonts.locator('option[value="font-divider"]')).toHaveAttribute(
    "disabled",
    "",
  );
  await expect(fonts.locator('optgroup[label="System fonts"]')).toHaveCount(1);
  await page.screenshot({ path: "test-results/note-fonts.png" });
});
