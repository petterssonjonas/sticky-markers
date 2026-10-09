import { expect, test, type Page } from "@playwright/test";

const storageKey = "sticky-markers-browser-demo-v1";
const tableSource = "| Name | Value |\n| --- | --- |\n| Basil | one |\n| Mint | two |\n";

async function openTable(page: Page) {
  await page.addInitScript(({ key, source }) => {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, JSON.stringify({
      config: {
        vaults: [{ id: "demo", name: "Primary", path: "primary", github: null }],
        activeVault: "demo", mainVault: "demo", styles: {}, recent: [],
        settings: { mode: "view", appearance: "light", palette: "classic", color: 0,
          font: "sans", fontSize: 16, width: 380, height: 440, toolbarPins: [] },
      },
      files: { "Table.md": source },
    }));
  }, { key: storageKey, source: tableSource });
  await page.goto("/?vault=demo&note=Table.md");
  await expect(page.locator(".lp-table td").first()).toHaveText("Basil");
  await page.locator(".lp-table td").first().click();
  return page.getByRole("textbox", { name: "Edit table cell" });
}

async function savedText(page: Page, path = "Table.md") {
  return page.evaluate(({ key, path }) =>
    JSON.parse(localStorage.getItem(key)!).files[path] as string,
  { key: storageKey, path });
}

test("rendered table typing keeps focus and is saved before blur or keyboard rename", async ({ page }) => {
  const input = await openTable(page);
  await input.fill("");
  await input.pressSequentially("IMPORTANT EDIT");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("IMPORTANT EDIT");
  await input.press("ControlOrMeta+s");
  await expect.poll(() => savedText(page)).toContain("| IMPORTANT EDIT | one |");
  await expect(input).toBeFocused();

  const opening = page.waitForEvent("popup");
  await input.press("F2");
  const rename = await opening;
  await rename.getByRole("textbox", { name: "Note name" }).fill("Renamed table");
  await rename.getByRole("button", { name: "Rename", exact: true }).click();
  await page.waitForURL(/Renamed/);
  await expect.poll(() => savedText(page, "Renamed table.md"))
    .toContain("| IMPORTANT EDIT | one |");
  await expect(page.locator(".lp-table td").first()).toHaveText("IMPORTANT EDIT");
});

test("focused table cells participate in autosave and close without shifting later cell positions", async ({ page }) => {
  const input = await openTable(page);
  await input.fill("Basil | extra text");
  await expect(input).toBeFocused();
  await expect.poll(() => savedText(page)).toContain("| Basil \\| extra text | one |");
  await input.press("Enter");
  await page.locator(".lp-table td").nth(2).click();
  const next = page.getByRole("textbox", { name: "Edit table cell" });
  await next.fill("Changed Mint");
  await expect(next).toBeFocused();
  await page.getByRole("button", { name: "Close note to collection" }).click();
  const content = await savedText(page);
  expect(content).toContain("| Basil \\| extra text | one |");
  expect(content).toContain("| Changed Mint | two |");
});

test("Save captures the final native table input value before its input event arrives", async ({ page }) => {
  const input = await openTable(page);
  await input.evaluate((node) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
      .set!.call(node, "Final IME value");
  });
  await input.press("ControlOrMeta+s");
  await expect.poll(() => savedText(page)).toContain("| Final IME value | one |");
});
