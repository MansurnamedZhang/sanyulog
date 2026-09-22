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
    assert.equal(
      (
        await page.request.get("http://127.0.0.1:" + port + "/api/state")
      ).status(),
      401,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#login-form [name="username"]').fill("admin");
    await page
      .locator('#login-form [name="password"]')
      .fill("ui-test-password-only");
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    if (process.env.UI_AUTH_CAPTURE)
      await page.screenshot({ path: process.env.UI_AUTH_CAPTURE });
    await page.locator("#login-form button").click();
    await page.locator(".workspace").waitFor();
    const sessionCookie = (await page.context().cookies()).find(
      (c) => c.name === "process_log_session",
    );
    assert(sessionCookie.httpOnly && sessionCookie.sameSite === "Strict");
    assert(sessionCookie.expires > Date.now() / 1000 + 6 * 86400);
    await page.reload();
    await page.locator(".workspace").waitFor();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator("[data-action=select]").first().click();
    await page.locator(".nb-title").waitFor();
    // Simulate a page left open across the multi-account upgrade.
    await page.route("**/api/state", async (route) => {
      const headers = { ...route.request().headers() };
      delete headers["x-process-log-account"];
      await route.continue({ headers });
    });
    const legacyResult = await page.evaluate(async () => {
      const response = await fetch("/api/state");
      return { status: response.status, body: await response.json() };
    });
    assert.equal(legacyResult.status, 409);
    assert.equal(legacyResult.body.code, "page_refresh_required");
    assert.equal(await page.locator("#reauth-form").count(), 0);
    await page.unroute("**/api/state");
    await page.reload();
    await page.locator("[data-action=select]").first().click();
    await page.locator(".nb-title").waitFor();
    const firstDraftCell = page.locator(".nb-cell").first();
    const draftArea = firstDraftCell.locator("[data-source]");
    if (!(await draftArea.isVisible()))
      await firstDraftCell.locator('[data-nb="toggle"]').click();
    const beforeExpiry = await draftArea.inputValue();
    await page.request.post("http://127.0.0.1:" + port + "/api/auth/logout", {
      data: {},
      headers: { "X-Process-Log": "1", "X-Process-Log-Account": "owner" },
    });
    await draftArea.fill(beforeExpiry + "\n\n登录过期测试草稿");
    await page.locator("#reauth-form").waitFor();

    await page.locator('#reauth-form [name="username"]').fill("admin");
    await page
      .locator('#reauth-form [name="password"]')
      .fill("ui-test-password-only");
    await page.locator("#reauth-form button").click();
    await page.locator("#reauth-form").waitFor({ state: "hidden" });
    if (!(await draftArea.isVisible()))
      await firstDraftCell.locator('[data-nb="toggle"]').click();
    assert.equal(
      await draftArea.inputValue(),
      beforeExpiry + "\n\n登录过期测试草稿",
    );
    await page.locator('[data-nb="save"]').click();
    await page.locator("[data-save-error]").waitFor({ state: "hidden" });
    await firstDraftCell.locator('[data-nb="toggle"]').click();
    const popupPromise = page.waitForEvent("popup");
    await page.locator('[data-nb="export-image"]').first().click();
    const exported = await popupPromise;
    const download = await exported.waitForEvent("download");
    const imagePath = path.join(root, "cell.png");
    await download.saveAs(imagePath);
    assert(
      fs.statSync(imagePath).size > 10000,
      "PNG contains rendered content",
    );
    assert.equal(await exported.locator("#content h2").count(), 1);
    assert.equal(
      await exported.locator("#content .nb-cell-actions").count(),
      0,
    );
    assert(
      !(await exported.locator("#content").innerText()).includes(
        "learning_rate",
      ),
    );
    if (process.env.UI_EXPORT_CAPTURE)
      fs.copyFileSync(imagePath, process.env.UI_EXPORT_CAPTURE);
    await exported.emulateMedia({ media: "print" });
    assert(await exported.locator("header").isHidden());
    const pdfBytes = await exported.pdf({ preferCSSPageSize: true });
    assert(pdfBytes.subarray(0, 5).toString() === "%PDF-");
    assert(pdfBytes.length > 10000);
    await exported.close();
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
    assert(
      await first.locator("[data-source]").isVisible(),
      "clicking outside must not change source mode",
    );
    const sample =
      '# 标题\n\n**粗体**与*斜体*，`inline` 和 $x^2$。\n\n- 一级\n  - 子项\n\n```python\nprint("hello")\n```\n\n$$\nE=mc^2\n$$\n\n| 名称 | 备注 |\n| --- | --- |\n| 原文 | 邻格保留 |\n| 下一行 | 不覆盖 |';
    await area.fill(sample);
    await first.locator('[data-nb="toggle"]').click();
    const rich = first.locator(".nb-rich-content");
    await rich.waitFor();
    assert.equal(await rich.locator("h1").innerText(), "标题");
    assert.equal(await rich.locator("strong").innerText(), "粗体");
    assert.equal(await rich.locator("ul ul li").innerText(), "子项");
    assert.equal(await rich.locator("pre code").innerText(), 'print("hello")');
    assert.equal(await rich.locator("math").count(), 2);
    await page.locator(".nb-title").click();
    assert(
      await rich.isVisible(),
      "clicking another block keeps visual editing",
    );
    await first.locator('[data-nb="toggle"]').click();
    assert.equal(
      await area.inputValue(),
      sample,
      "mode-only switches preserve exact source",
    );
    await first.locator('[data-nb="toggle"]').click();
    const richCell = rich.locator("table tr").nth(1).locator("td").first();
    await richCell.locator("p").click();
    await first.locator('[data-tool="row"]').click();
    assert.equal(await rich.locator("table tr").count(), 4);
    await rich.locator("table tr").nth(2).locator("td p").first().click();
    await first.locator('[data-tool="delete-row"]').click();
    assert.equal(await rich.locator("table tr").count(), 3);
    await richCell.locator("p").click();
    await page.waitForFunction(
      () =>
        getSelection().anchorNode?.parentElement?.closest("td")?.textContent ===
        "原文",
    );
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("第二段");
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate(() =>
      navigator.clipboard.writeText('\n\n第三段,含"引号"'),
    );
    await page.keyboard.press("Control+V");
    await page.waitForFunction(() =>
      document
        .querySelector(".nb-rich-content table")
        .textContent.includes("第三段"),
    );
    assert.equal(
      await rich.locator("table tr").nth(1).locator("td").nth(1).innerText(),
      "邻格保留",
    );
    assert.equal(
      await rich.locator("table tr").nth(2).locator("td").first().innerText(),
      "下一行",
    );
    await page.keyboard.press("Tab");
    assert(
      await rich.isVisible(),
      "moving between table cells keeps visual editing",
    );
    await first.locator('[data-nb="toggle"]').click();
    const roundTrip = await area.inputValue();
    assert(
      roundTrip.includes("第二段<br><br>第三段"),
      "blank paragraphs survive serialization",
    );
    assert(roundTrip.includes("$x^2$") && roundTrip.includes("E=mc^2"));
    assert(roundTrip.includes('print("hello")') && roundTrip.includes("子项"));
    await first.locator('[data-nb="toggle"]').click();
    assert((await richCell.innerText()).includes("第三段"));
    assert((await richCell.innerText()).includes("第二段"));
    assert.equal(await rich.locator("math").count(), 2);
    await rich.locator('[data-type="inline-math"]').click();
    const formula = first.locator(".nb-formula-dialog");
    await formula.locator("textarea").fill("a^2+b^2");
    const richSaved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        (response.request().postData() || "").includes("a^2+b^2"),
    );
    await formula.locator('[type="submit"]').click();
    assert.equal((await richSaved).status(), 200);
    await page.reload();
    await page.locator("[data-action=select]").first().click();
    await rich.locator("math").first().waitFor();
    assert(
      (await richCell.innerText()).includes("第三段"),
      "visual edits survive a reload",
    );
    assert.equal(
      await rich
        .locator('[data-type="inline-math"]')
        .getAttribute("data-latex"),
      "a^2+b^2",
    );
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    if (process.env.UI_RICH_CAPTURE) {
      await richCell.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: process.env.UI_RICH_CAPTURE,
        fullPage: false,
      });
    }
    await first.locator('[data-nb="toggle"]').click();
    assert((await area.inputValue()).includes("$a^2+b^2$"));
    await area.fill(original);
    const fallbackContext = await browser.newContext({
      storageState: await page.context().storageState(),
    });
    const fallback = await fallbackContext.newPage();
    try {
      await fallback.route("**/vendor/rich-editor.js", (route) =>
        route.abort(),
      );
      await fallback.goto("http://127.0.0.1:" + port);
      await fallback.locator("[data-action=select]").first().click();
      await fallback
        .locator(".nb-cell")
        .first()
        .locator("[data-source]")
        .waitFor();
      assert(
        (
          await fallback
            .locator(".nb-cell")
            .first()
            .locator("[data-source]")
            .inputValue()
        ).length > 0,
      );
    } finally {
      await fallbackContext.close();
    }
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
    const gridCell = grid.locator('[data-grid-row="1"][data-grid-col="3"]');
    const neighbor = await grid
      .locator('[data-grid-row="2"][data-grid-col="3"]')
      .inputValue();
    const paragraphs = '第一段，包含逗号,和"引号"\n\n第二段文字';
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await gridCell.fill("前缀：");
    await gridCell.press("End");
    await page.evaluate(
      (text) => navigator.clipboard.writeText(text),
      paragraphs,
    );
    await gridCell.press("Control+V");
    await page.waitForFunction(
      (expected) =>
        document.querySelector('[data-grid-row="1"][data-grid-col="3"]')
          .value === expected,
      "前缀：" + paragraphs,
    );
    const gridSaved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().includes("/api/records/") &&
        (response.request().postData() || "").includes("third paragraph"),
    );
    await gridCell.press("Enter");
    await gridCell.pressSequentially("third paragraph");
    const expectedGridText = "前缀：" + paragraphs + "\nthird paragraph";
    assert.equal(await gridCell.inputValue(), expectedGridText);
    assert.equal(
      await grid.locator('[data-grid-row="2"][data-grid-col="3"]').inputValue(),
      neighbor,
    );
    assert.equal((await gridSaved).status(), 200);
    await page.reload();
    await page.locator("[data-action=select]").first().click();
    assert.equal(
      await page.locator('[data-grid-row="1"][data-grid-col="3"]').inputValue(),
      expectedGridText,
    );
    assert.equal(
      await page.locator('[data-grid-row="2"][data-grid-col="3"]').inputValue(),
      neighbor,
    );

    await page.locator("#detail").evaluate((e) => (e.scrollTop = 0));
    await page.setViewportSize({ width: 768, height: 1100 });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('[data-action="manage-accounts"]').click();
    const createAccount = page.locator("[data-create-account]");
    await createAccount.locator('[name="username"]').fill("ui-alice");
    await createAccount
      .locator('[name="password"]')
      .fill("alice-test-password-only");
    await createAccount.locator('[type="submit"]').click();
    const aliceRow = page
      .locator(".account-row")
      .filter({ hasText: "ui-alice" });
    await aliceRow.waitFor();
    const aliceContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    try {
      const alicePage = await aliceContext.newPage();
      await alicePage.goto("http://127.0.0.1:" + port);
      await alicePage.locator('#login-form [name="username"]').fill("ui-alice");
      await alicePage
        .locator('#login-form [name="password"]')
        .fill("alice-test-password-only");
      const aliceStateResponse = alicePage.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/state",
      );
      await alicePage.locator("#login-form button").click();
      const stateResponse = await aliceStateResponse;
      assert.equal(stateResponse.status(), 200);
      const aliceState = await stateResponse.json();
      await alicePage.locator(".workspace").waitFor();
      assert.equal(aliceState.records.length, 0);
      assert.equal(aliceState.projects.length, 0);
      assert(
        await alicePage.locator('[data-action="manage-accounts"]').isHidden(),
      );
      await aliceRow.getByRole("button", { name: "停用", exact: true }).click();
      await aliceRow
        .getByRole("button", { name: "启用", exact: true })
        .waitFor();
      await alicePage.reload();
      await alicePage.locator("#login-form").waitFor();
    } finally {
      await aliceContext.close();
    }
    await page.locator(".accounts-dialog > .auth-cancel").click();
    await page.locator('[data-action="change-password"]').click();
    const passwordForm = page
      .locator(".auth-dialog form")
      .filter({ has: page.locator('[name="new_password"]') });
    await passwordForm
      .locator('[name="password"]')
      .fill("ui-test-password-only");
    await passwordForm
      .locator('[name="new_password"]')
      .fill("ui-new-password-only");
    await passwordForm
      .locator('[name="confirm_password"]')
      .fill("ui-new-password-only");
    await passwordForm.locator('[type="submit"]').click();
    await page.locator("#reauth-form").waitFor();
    assert.equal(
      (
        await page.request.get("http://127.0.0.1:" + port + "/api/state")
      ).status(),
      401,
    );
    await page.locator('#reauth-form [name="username"]').fill("admin");
    await page
      .locator('#reauth-form [name="password"]')
      .fill("ui-new-password-only");
    await page.locator("#reauth-form button").click();
    await page.locator("#reauth-form").waitFor({ state: "hidden" });
    await page.locator('[data-action="logout"]').click();
    await page.locator("#login-form").waitFor();
    assert.equal(
      (
        await page.request.get("http://127.0.0.1:" + port + "/api/state")
      ).status(),
      401,
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: multi-account creation/isolation/disable; login, persistent session, expired-session draft recovery, password change and logout; 6 viewport widths; focus mode; menus; Markdown selection, lists and manual modes; mobile navigation; workspace switch; table overflow; visual Markdown/table/math editing and save/reload; no JS page errors.",
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
