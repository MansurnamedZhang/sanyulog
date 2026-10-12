const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanyu-code-ui-"));
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
      fixture.on("error", reject);
      fixture.stderr.on("data", (chunk) => process.stderr.write(chunk));
    });
    browser = await chromium.launch({
      headless: true,
      ...(process.env.UI_BROWSER_PATH
        ? { executablePath: process.env.UI_BROWSER_PATH }
        : {}),
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}`);
    await page.locator('[name="username"]').fill("admin");
    await page.locator('[name="password"]').fill("ui-test-password-only");
    await page.locator("#login-form button").click();
    await page.locator(".record-card").first().click();
    const first = page.locator(".nb-cell").nth(0),
      codeCell = page.locator(".nb-cell").nth(1);
    await codeCell.locator(".nb-code-block code").waitFor();
    assert((await codeCell.locator(".hljs-number").count()) > 0);
    await codeCell.locator('[data-nb="toggle"]').click();
    const codeSource = codeCell.locator("[data-source]");
    const powershell =
      '# 训练配置\n$rank = 32\nWrite-Host "完成 <script>alert(1)</script>"\n' +
      "# " +
      "a".repeat(250);
    await codeSource.fill(powershell);
    await codeCell.locator("[data-language]").selectOption("powershell");
    await codeCell.locator('[data-nb="toggle"]').click();
    assert.equal(await codeCell.locator("pre code").textContent(), powershell);
    assert((await codeCell.locator(".hljs-variable").count()) > 0);
    await codeCell.locator('[data-code-action="copy"]').click();
    assert.equal(
      (await page.evaluate(() => navigator.clipboard.readText())).replace(
        /\r\n/g,
        "\n",
      ),
      powershell,
    );
    await page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: undefined,
      }),
    );
    await codeCell.locator('[data-nb="code-copy"]').click();
    await page.evaluate(() => delete navigator.clipboard);
    assert.equal(
      (await page.evaluate(() => navigator.clipboard.readText())).replace(
        /\r\n/g,
        "\n",
      ),
      powershell,
    );
    await codeCell.focus();
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() =>
      document
        .querySelector("[data-save-status]")
        ?.textContent.includes("所有修改已保存"),
    );
    await page.locator("[data-save-error]").waitFor({ state: "hidden" });
    await page.reload();
    await codeCell.locator(".nb-code-block").waitFor();
    assert.equal(
      await codeCell.locator("[data-language]").inputValue(),
      "powershell",
    );
    assert.equal(await codeCell.locator("pre code").textContent(), powershell);

    await first.locator('[data-nb="toggle"]').click();
    const source = first.locator("[data-source]");
    const markdown =
      '## 训练与接口\n\n```python\ndef train(rank=32):\n    return "<img src=x onerror=alert(1)>"\n```\n\n```js\nconst config = { learningRate: 0.0001 };\nconsole.log(config);\n```\n\n```json\n{ "rank": 32, "enabled": true }\n```\n\n```customlang\n  原始内容 <script>alert(1)</script>\n```';
    await source.fill(markdown);
    await first.locator('[data-nb="toggle"]').click();
    const rich = first.locator(".nb-rich-content");
    await rich.locator(".nb-code-block").first().waitFor();
    assert.equal(await rich.locator(".nb-code-block").count(), 4);
    assert((await rich.locator(".hljs-keyword").count()) > 0);
    assert.equal(await rich.locator("script,img").count(), 0);
    const python = rich.locator(".nb-code-block").nth(0);
    await python.locator("pre code").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" # kept");
    await rich.evaluate((el) => {
      const editor = el.editor;
      let position;
      editor.state.doc.descendants((node, pos) => {
        if (position === undefined && node.type.name === "codeBlock")
          position = pos + 1;
      });
      editor.commands.setTextSelection(position);
      editor.commands.focus();
    });
    const beforeTab = await python.locator("pre code").textContent();
    const offset = 0;
    await page.keyboard.press("Tab");
    assert.equal(
      await python.locator("pre code").textContent(),
      beforeTab.slice(0, offset) + "    " + beforeTab.slice(offset),
    );
    await page.keyboard.press("Shift+Tab");
    assert.equal(await python.locator("pre code").textContent(), beforeTab);
    await python.locator('[data-code-action="copy"]').click();
    assert(
      (await page.evaluate(() => navigator.clipboard.readText())).includes(
        " # kept",
      ),
    );
    const selectionBeforeLanguage = await rich.evaluate((el) => {
      const selection = el.editor.state.selection;
      return { from: selection.from, to: selection.to };
    });
    await python.locator("select").selectOption("javascript");
    assert.deepEqual(
      await rich.evaluate((el) => {
        const selection = el.editor.state.selection;
        return { from: selection.from, to: selection.to };
      }),
      selectionBeforeLanguage,
    );
    assert.equal(await python.getAttribute("data-code-language"), "javascript");
    const unknown = rich.locator(".nb-code-block").nth(3);
    assert.equal(
      await unknown.locator("pre code").textContent(),
      "  原始内容 <script>alert(1)</script>",
    );
    assert.equal(await unknown.locator('[class^="hljs-"]').count(), 0);
    for (const width of [2560, 1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `page overflow at ${width}`,
      );
      if (width === 320) {
        const pre = codeCell.locator("pre");
        assert(await pre.evaluate((e) => e.scrollWidth > e.clientWidth));
        await codeCell.locator('[data-code-action="wrap"]').click();
        assert(await pre.evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
      }
      if (process.env.UI_CODE_CAPTURE_DIR && [1440, 390].includes(width)) {
        fs.mkdirSync(process.env.UI_CODE_CAPTURE_DIR, { recursive: true });
        await first.screenshot({
          path: path.join(process.env.UI_CODE_CAPTURE_DIR, `code-${width}.png`),
        });
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await first.locator('[data-nb="toggle"]').click();
    assert((await source.inputValue()).includes("```javascript"));
    assert((await source.inputValue()).includes(" # kept"));
    await first.locator('[data-nb="toggle"]').click();
    await rich.locator(".nb-code-block").first().waitFor();
    assert.equal(await rich.locator(".nb-code-block").count(), 4);
    const popupPromise = page.waitForEvent("popup");
    await codeCell.locator('[data-nb="export-pdf"]').click();
    const popup = await popupPromise;
    await popup.locator("#content .nb-code-block").waitFor();
    assert((await popup.locator(".hljs-variable").count()) > 0);
    assert.equal(await popup.locator("#content button").count(), 0);
    assert.equal(
      await popup.locator("#content pre code").textContent(),
      powershell,
    );
    await popup.emulateMedia({ media: "print" });
    const pdf = await popup.pdf({ preferCSSPageSize: true });
    assert(pdf.length > 1000);
    await popup.close();
    const imagePopupPromise = page.waitForEvent("popup");
    await codeCell.locator('[data-nb="export-image"]').click();
    const imagePopup = await imagePopupPromise;
    const imageDownload = await imagePopup.waitForEvent("download");
    const imagePath = path.join(root, "code.png");
    await imageDownload.saveAs(imagePath);
    const imageBytes = fs.readFileSync(imagePath);
    assert(imageBytes.length > 10000);
    assert.equal(
      await imagePopup.locator("#content [data-code-action]").count(),
      0,
    );
    assert((await imagePopup.locator(".hljs-variable").count()) > 0);
    if (process.env.UI_CODE_CAPTURE_DIR)
      fs.copyFileSync(
        imagePath,
        path.join(process.env.UI_CODE_CAPTURE_DIR, "code-export.png"),
      );
    await imagePopup.close();
    assert.deepEqual(errors, []);
    console.log(
      "PASS code UI: rich editable highlighting/language change/source roundtrip; independent preview/edit/save/reload; exact copy and LAN fallback; 5 widths, scroll/wrap, unknown/hostile input; highlighted PNG/PDF.",
    );
  } finally {
    await browser?.close();
    fixture.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
