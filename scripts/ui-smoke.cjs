const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "process-log-ui-"));
  const fixture = spawn(
    process.env.PYTHON || "python",
    ["scripts/ui-fixture.py", root],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let browser;
  try {
    const port = await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error("Fixture startup timeout")),
        15000,
      );
      fixture.stdout.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/UI_READY:(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      fixture.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      fixture.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error("Fixture exited " + code));
      });
      fixture.stderr.on("data", (chunk) => process.stderr.write(chunk));
    });
    browser = await chromium.launch({
      ...(process.env.UI_BROWSER_PATH
        ? { executablePath: process.env.UI_BROWSER_PATH }
        : {}),
      headless: true,
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://127.0.0.1:" + port);
    await page.locator("[data-action=select]").first().click();
    await page.locator(".nb-title").waitFor();
    for (const [width, height] of [
      [1440, 1000],
      [1280, 900],
      [1024, 768],
      [768, 1100],
      [390, 844],
      [320, 740],
    ]) {
      await page.setViewportSize({ width, height });
      const bounds = await page.locator(".nb-cell-main").first().boundingBox();
      assert(
        bounds.width > width * 0.4,
        `Cell width ${bounds.width} at ${width}`,
      );
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `Overflow ${width}`,
      );
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator("[data-action=focus-mode]").click();
    assert(await page.locator(".record-pane").isHidden());
    assert(
      (await page.locator(".nb-cell-main").first().boundingBox()).width > 700,
    );
    await page.locator("[data-action=focus-mode]").click();
    await page.locator(".note-menu summary").click();
    assert(await page.locator("[data-action=delete-record]").isVisible());
    await page.keyboard.press("Escape");
    assert(await page.locator("[data-action=delete-record]").isHidden());
    await page.setViewportSize({ width: 390, height: 844 });
    const first = page.locator(".nb-cell").first();
    await first.locator("[data-nb=toggle]").click();
    assert(await first.locator(".nb-format-toolbar").isVisible());
    const area = first.locator("[data-source]"),
      original = await area.inputValue();
    await area.fill("手\n发丝\n服装褶皱");
    await area.selectText();
    await first.locator("[data-format=unordered]").click();
    assert.equal(await area.inputValue(), "- 手\n- 发丝\n- 服装褶皱");
    await first.locator("[data-format=indent]").click();
    assert.equal(
      await area.inputValue(),
      "    - 手\n    - 发丝\n    - 服装褶皱",
    );
    await area.fill(
      Array.from({ length: 120 }, (_, i) => "连续记录第 " + i + " 行").join(
        "\n",
      ),
    );
    await area.press("Control+End");
    await area.evaluate((el) => {
      const container = el.closest("#detail");
      container.scrollTop +=
        el.getBoundingClientRect().bottom -
        container.getBoundingClientRect().bottom +
        100;
    });
    await page.waitForTimeout(400);
    for (let i = 0; i < 3; i++) {
      const before = await page.locator("#detail").evaluate((e) => e.scrollTop);
      await area.press("Enter");
      await page.waitForTimeout(150);
      const after = await page.locator("#detail").evaluate((e) => e.scrollTop);
      assert(Math.abs(after - before) < 65, `Enter jumped ${after - before}px`);
    }
    for (const key of ["a", "Backspace", "Backspace"]) {
      const before = await page.locator("#detail").evaluate((e) => e.scrollTop);
      await area.press(key);
      await page.waitForTimeout(100);
      const after = await page.locator("#detail").evaluate((e) => e.scrollTop);
      assert(
        Math.abs(after - before) < 65,
        `${key} jumped ${after - before}px`,
      );
    }
    await area.fill(original);
    await page.locator(".nb-title").click();
    assert(await first.locator(".nb-format-toolbar").isHidden());
    await page.locator("[data-action=back-list]").click();
    await page.locator(".record-pane").waitFor({ state: "visible" });
    assert(await page.locator(".record-pane").isVisible());
    assert(await page.locator("#detail").isHidden());
    await page.locator("[data-action=select]").first().click();
    await page.locator("[data-action=navigation]").click();
    await page.locator(".sidebar").waitFor({ state: "visible" });
    assert(await page.locator(".sidebar").isVisible());
    await page.locator("#workspace-select").selectOption({ label: "日常研究" });
    await page
      .getByText("研究随记", { exact: true })
      .waitFor({ state: "attached" });
    await page.locator(".sidebar").waitFor({ state: "hidden" });
    assert(await page.locator(".sidebar").isHidden());
    await page.locator("[data-action=navigation]").click();
    await page.locator("#workspace-select").selectOption("default");
    await page.locator("[data-action=select]").first().click();
    const grid = page.locator(".nb-data-grid").first();
    await grid.scrollIntoViewIfNeeded();
    assert((await grid.boundingBox()).width < 390);
    await page.locator("#detail").evaluate((e) => (e.scrollTop = 0));
    await page.setViewportSize({ width: 768, height: 1100 });
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.deepEqual(errors, []);
    console.log(
      "PASS: 6 viewport widths; focus mode; menus; Markdown selection, lists and auto-preview; mobile navigation; workspace switch; table overflow; no JS page errors.",
    );
  } finally {
    if (browser) await browser.close();
    if (fixture.exitCode === null) {
      const exited = new Promise((resolve) => fixture.once("exit", resolve));
      fixture.kill();
      await exited;
    }
    const resolved = path.resolve(root),
      prefix = path.join(path.resolve(os.tmpdir()), "process-log-ui-");
    if (!resolved.startsWith(prefix))
      throw new Error("Unexpected temporary directory");
    fs.rmSync(resolved, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 200,
    });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
