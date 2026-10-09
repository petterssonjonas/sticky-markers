import { test, expect } from "@playwright/test";

test("malformed attachment URLs leave collection navigation and source editing usable", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("sticky-markers-browser-demo-v1", JSON.stringify({
      config: { vaults: [{ id: "demo", name: "Primary", path: "primary", github: null }], activeVault: "demo", mainVault: "demo", settings: { mode: "view", appearance: "light" }, styles: {}, recent: [] },
      files: { "Malformed.md": "# A usable note\n\n![](bad%zz.png)\n\n![](bad%C0%AF.png)\n\nText remains editable." },
    }));
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open notes panel", exact: true }).click();
  await expect(page.locator(".missing-image")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "New note", exact: true })).toBeVisible();
  await page.locator(".note-card").click();
  await expect(page.locator(".note-window")).toBeVisible();
  await page.getByRole("button", { name: "Note menu", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText("![](bad%zz.png)");
  await expect(page.locator(".cm-content")).toContainText("Text remains editable.");
  expect(errors).toEqual([]);
});

test("local images with encoded spaces load when visible and release offscreen previews", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const content = "![](../assets/my%20image.png)\n\n" + "ordinary text\n\n".repeat(100) + "![](../assets/later.png)";
  // Render the real Markdown component with a deterministic native IPC stand-in.
  // This proves decoding/visibility behavior without depending on local files
  // from the browser-only demo or making any external network requests.
  await page.route("**/src/api.ts", (route) => route.fulfill({ contentType: "text/javascript", body: `
    window.assetCalls = [];
    export async function external() {}
    export async function call(operation, args) {
      window.assetCalls.push(args.path);
      if (!['assets/my image.png', 'assets/later.png'].includes(args.path)) throw new Error('Wrong path');
      return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
    }
  ` }));
  await page.route("**/attachment-fixture.html", (route) => route.fulfill({ contentType: "text/html", body: `
    <html><body><div id="viewport" style="width:320px;height:200px;overflow:auto"><div id="fixture"></div></div>
    <script type="module">
      import RefreshRuntime from '/@react-refresh';
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      const {Markdown} = await import('/src/markdown.tsx');
      const content = ${JSON.stringify(content)};
      ReactDOM.createRoot(document.getElementById('fixture')).render(React.createElement(Markdown, {content, dark: false, vaultId:'vault', path:'notes/Note.md', onWiki() {}}));
    </script></body></html>
  ` }));
  await page.goto("/attachment-fixture.html");
  await expect(page.locator("#fixture img")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => (window as unknown as { assetCalls: string[] }).assetCalls)).toEqual(["assets/my image.png"]);
  await expect.poll(() => page.locator("#fixture img").evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(1);
  await page.locator("#viewport").evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await expect.poll(() => page.evaluate(() => (window as unknown as { assetCalls: string[] }).assetCalls)).toEqual(["assets/my image.png", "assets/later.png"]);
  await expect(page.locator("#fixture img")).toHaveCount(1);
  await expect(page.locator("#fixture img").first()).toHaveAttribute("src", /^data:image\/png/);
  expect(errors).toEqual([]);
});

test("a rendering exception is contained and corrected source recovers the preview", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const invalid = "[[\ud800]]"; // Deliberate synchronous renderer fault injection.
  await page.route("**/render-boundary-fixture.html", (route) => route.fulfill({ contentType: "text/html", body: `
    <html><body><button id="edit">Correct source</button><div id="fixture"></div>
    <script type="module">
      import RefreshRuntime from '/@react-refresh';
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      const {Markdown} = await import('/src/markdown.tsx');
      const root = ReactDOM.createRoot(document.getElementById('fixture'));
      function show(content) { root.render(React.createElement(Markdown, {content, dark: false, vaultId:'vault', path:'Note.md', onWiki() {}})); }
      show(${JSON.stringify(invalid)});
      document.getElementById('edit').onclick = () => show('# Corrected note');
    </script></body></html>
  ` }));
  await page.goto("/render-boundary-fixture.html");
  await expect(page.getByRole("status")).toContainText("Preview unavailable");
  await page.getByRole("button", { name: "Correct source" }).click();
  await expect(page.getByRole("heading", { name: "Corrected note" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
  expect(errors).toEqual([]);
});
