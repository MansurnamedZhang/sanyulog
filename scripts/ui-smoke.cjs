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
    const notebookPdfPopupPromise = page.waitForEvent("popup");
    await page.locator('[data-nb="export-notebook-pdf"]').click();
    const notebookPdfPopup = await notebookPdfPopupPromise;
    await notebookPdfPopup
      .locator("#content .nb-export-cell")
      .first()
      .waitFor();
    assert.equal(
      await notebookPdfPopup.locator("#content .nb-export-cell").count(),
      4,
    );
    assert.equal(
      await notebookPdfPopup.locator("#content h1").innerText(),
      await page.locator(".nb-title").inputValue(),
    );
    assert(
      (await notebookPdfPopup.locator("#content").innerText()).includes(
        "learning_rate",
      ),
    );
    assert(
      (await notebookPdfPopup.locator("#content").innerText()).includes("基线"),
    );
    await notebookPdfPopup.emulateMedia({ media: "print" });
    const wholePdfBytes = await notebookPdfPopup.pdf({
      preferCSSPageSize: true,
    });
    assert(wholePdfBytes.subarray(0, 5).toString() === "%PDF-");
    assert(wholePdfBytes.length > pdfBytes.length);
    if (process.env.UI_PAGE_PDF_CAPTURE)
      fs.writeFileSync(process.env.UI_PAGE_PDF_CAPTURE, wholePdfBytes);
    await notebookPdfPopup.close();
    for (const [width, height] of [
      [2560, 1440],
      [1920, 1080],
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
      if (width >= 1920) {
        assert(
          bounds.width > (width === 2560 ? 1700 : 1100),
          `Wide-screen cell width ${bounds.width} at ${width}`,
        );
        assert(
          (await page.locator(".record-pane").boundingBox()).width >= 330,
          `Wide-screen record pane at ${width}`,
        );
      }
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `Overflow ${width}`,
      );
      if (width === 2560 && process.env.UI_WIDE_CAPTURE)
        await page.screenshot({ path: process.env.UI_WIDE_CAPTURE });
    }
    await page.setViewportSize({ width: 2560, height: 1440 });
    await page.locator("[data-action=focus-mode]").click();
    assert(
      (await page.locator(".nb-cell-main").first().boundingBox()).width > 1700,
      "Wide-screen focus mode uses the available width",
    );
    await page.locator("[data-action=focus-mode]").click();
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
    const pastedFlowchart = [
      "flowchart TD",
      "U[客户文字与输入图] --> API[接口服务]",
      "```css",
      "subgraph S[Python 业务服务]",
      "API --> P[意图提取]",
      "P --> R[关键词与向量检索]",
      "R --> J[候选比较与选择]",
      "J --> C[提示词拼装与校验]",
      "C --> PLAN[保存生成计划]",
      "end",
      "DB[(SQLite 模板与业务记录)] --> R",
      "DB --> J",
      "DB --> C",
      "IDX[内存向量索引] --> R",
      "LLM[语言模型接口] --- P",
      "LLM --- J",
      "PLAN --> W[后台任务进程]",
      "W --> COMFY[ComfyUI GPU 服务]",
      "COMFY --> RESULT[视频与任务结果]",
      "RESULT --> DB",
      "```",
    ].join("\n");
    await area.fill(pastedFlowchart);
    await area.press("Control+A");
    await first.locator('[data-format="mermaid"]').click();
    const mermaidSource = await area.inputValue();
    assert(mermaidSource.startsWith("```mermaid\nflowchart TD"));
    assert(!mermaidSource.includes("```css"));
    await first.locator('[data-nb="toggle"]').click();
    const diagram = first.locator(".nb-mermaid-output img");
    await diagram.waitFor();
    assert(
      await diagram.evaluate((img) => img.complete && img.naturalWidth > 0),
    );
    assert(await first.locator('[data-nb="mermaid-edit"]').isVisible());
    assert((await diagram.getAttribute("alt")).includes("客户文字与输入图"));
    assert((await diagram.getAttribute("alt")).includes("ComfyUI GPU 服务"));
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "Mermaid stays inside the mobile cell",
    );
    if (process.env.UI_MERMAID_CAPTURE) {
      await page.setViewportSize({ width: 1440, height: 2500 });
      await first
        .locator(".nb-mermaid")
        .screenshot({ path: process.env.UI_MERMAID_CAPTURE });
      await page.setViewportSize({ width: 390, height: 844 });
    }
    const fullDiagramPopupPromise = page.waitForEvent("popup");
    await page.locator('[data-nb="export-notebook-pdf"]').click();
    const fullDiagramPopup = await fullDiagramPopupPromise;
    const fullDiagramImage = fullDiagramPopup.locator(".nb-mermaid-output img");
    await fullDiagramImage.waitFor();
    assert(
      await fullDiagramImage.evaluate(
        (img) => img.complete && img.naturalWidth > 0,
      ),
    );
    await fullDiagramPopup.emulateMedia({ media: "print" });
    const fullDiagramPdf = await fullDiagramPopup.pdf({
      preferCSSPageSize: true,
    });
    assert(fullDiagramPdf.subarray(0, 5).toString() === "%PDF-");
    await fullDiagramPopup.close();
    const diagramPopupPromise = page.waitForEvent("popup");
    await first.locator('[data-nb="export-image"]').click();
    const diagramPopup = await diagramPopupPromise;
    const diagramErrors = [];
    diagramPopup.on("pageerror", (error) => diagramErrors.push(error.message));
    diagramPopup.on("requestfailed", (request) =>
      diagramErrors.push(request.url() + ": " + request.failure()?.errorText),
    );
    const diagramDownload = await diagramPopup
      .waitForEvent("download", { timeout: 15000 })
      .catch(async (error) => {
        throw new Error(
          "Mermaid PNG export: " +
            diagramPopup.url() +
            " | " +
            (await diagramPopup.locator("body").innerText()).slice(0, 500) +
            " | " +
            JSON.stringify(diagramErrors.slice(0, 5)),
          { cause: error },
        );
      });
    const diagramImagePath = path.join(root, "diagram.png");
    await diagramDownload.saveAs(diagramImagePath);
    assert(fs.statSync(diagramImagePath).size > 10000);
    assert.equal(
      await diagramPopup.locator(".nb-mermaid-output img").count(),
      1,
    );
    await diagramPopup.emulateMedia({ media: "print" });
    const diagramPdf = await diagramPopup.pdf({ preferCSSPageSize: true });
    assert(diagramPdf.subarray(0, 5).toString() === "%PDF-");
    assert(diagramPdf.length > 10000);
    await diagramPopup.close();
    await first.locator('[data-nb="toggle"]').click();
    assert.equal(await area.inputValue(), mermaidSource);
    await first.locator('[data-nb="toggle"]').click();
    await first.locator('[data-nb="mermaid-edit"]').click();
    const diagramDialog = page.locator(".nb-mermaid-dialog");
    const updatedDiagram =
      mermaidSource.slice("```mermaid\n".length, -"\n```".length) +
      "\nRESULT --> CHECK[补充检查]";
    await diagramDialog.locator("textarea").fill(updatedDiagram);
    const diagramSaved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        (response.request().postData() || "").includes("补充检查"),
    );
    await diagramDialog.locator('[type="submit"]').click();
    assert.equal((await diagramSaved).status(), 200);
    await page.reload();
    await page.locator("[data-action=select]").first().click();
    await page.waitForFunction(() =>
      document
        .querySelector(".nb-mermaid-editor img")
        ?.alt.includes("补充检查"),
    );
    await first.locator('[data-nb="toggle"]').click();
    assert((await area.inputValue()).includes("RESULT --> CHECK[补充检查]"));
    const escapedDiagram = [
      "```mermaid",
      "flowchart TD",
      '&#x20;   A["客户原话"] --> B["第一轮大模型\\<br/>提取动作、修饰、限制和证据"]',
      '&#x20;   B --> C["程序生成检索条件\\<br/>提及内容 + 类型 + 相关上下文"]',
      '&#x20;   D["完整概念库\\<br/>长期保存在服务端"] --> E["关键词检索 + 向量检索"]',
      "&#x20;   C --> E",
      '&#x20;   E --> F["每条提及保留少量候选\\<br/>过滤、合并、去重"]',
      '&#x20;   F --> G["第二轮大模型\\<br/>一次处理本次所有提及"]',
      '&#x20;   G --> H["标准化结果"]',
      '&#x20;   G -->|"没有合适候选"| I["有界扩大检索\\<br/>仍不匹配则保留未知"]',
      "```",
    ].join("\n");
    await area.fill(escapedDiagram);
    await first.locator('[data-nb="toggle"]').click();
    await first.locator(".nb-mermaid-output").waitFor();
    await page.waitForFunction(
      () =>
        !!document.querySelector(".nb-mermaid-output img, .nb-mermaid-invalid"),
    );
    assert.equal(
      await first.locator(".nb-mermaid-invalid").count(),
      0,
      await first.locator(".nb-mermaid-output").innerText(),
    );
    await first.locator(".nb-mermaid-output img").waitFor();
    const escapedPopupPromise = page.waitForEvent("popup");
    await first.locator('[data-nb="export-image"]').click();
    const escapedPopup = await escapedPopupPromise;
    const escapedDownload = await escapedPopup.waitForEvent("download");
    const escapedImagePath = path.join(root, "escaped-diagram.png");
    await escapedDownload.saveAs(escapedImagePath);
    assert(fs.statSync(escapedImagePath).size > 10000);
    await escapedPopup.close();
    if (process.env.UI_MERMAID_ESCAPED_CAPTURE)
      await first.locator(".nb-mermaid").screenshot({
        path: process.env.UI_MERMAID_ESCAPED_CAPTURE,
      });
    await first.locator('[data-nb="toggle"]').click();
    const invalidDiagram = "```mermaid\nflowchart TD\nA[未闭合\n```";
    await area.fill(invalidDiagram);
    await first.locator('[data-nb="toggle"]').click();
    await first.locator(".nb-mermaid-invalid").waitFor();
    assert(
      (await first.locator(".nb-mermaid-output").innerText()).includes(
        "语法有误",
      ),
    );
    await first.locator('[data-nb="toggle"]').click();
    assert.equal(await area.inputValue(), invalidDiagram);
    await area.fill("可视化插入测试");
    await first.locator('[data-nb="toggle"]').click();
    await first.locator('[data-format="mermaid"]').click();
    await first.locator(".nb-mermaid-output img").waitFor();
    await first.locator('[data-nb="toggle"]').click();
    assert((await area.inputValue()).includes("```mermaid"));
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

    await page.locator('[data-nb="append"][data-type="table"]').click();
    const singleColumnId = await page
      .locator(".nb-cell")
      .last()
      .getAttribute("data-cell");
    const singleColumn = page.locator(`[data-cell="${singleColumnId}"]`);
    page.once("dialog", (dialog) => dialog.accept());
    await singleColumn.locator('[data-nb="grid-delete-column"]').last().click();
    await page.setViewportSize({ width: 2560, height: 1440 });
    const tableText =
      "记录本次训练参数与验证结果，比较样本质量、运行时间和生成稳定性。".repeat(
        18,
      );
    const firstTableField = singleColumn.locator(
      '[data-grid-row="1"][data-grid-col="0"]',
    );
    const secondTableField = singleColumn.locator(
      '[data-grid-row="1"][data-grid-col="1"]',
    );
    await firstTableField.fill(tableText);
    await secondTableField.fill("workflow_identifier_".repeat(24));
    const desktopTableLayout = await firstTableField.evaluate((area) => ({
      fieldWidth: area.getBoundingClientRect().width,
      cellWidth: area.closest("td").getBoundingClientRect().width,
      height: area.getBoundingClientRect().height,
      contentHeight: area.scrollHeight,
      visibleHeight: area.clientHeight,
      rowIndexWidth: area
        .closest("tr")
        .firstElementChild.getBoundingClientRect().width,
      actionWidth: area.closest("tr").lastElementChild.getBoundingClientRect()
        .width,
    }));
    assert(
      desktopTableLayout.fieldWidth >= desktopTableLayout.cellWidth - 4,
      "Table inputs fill wide-screen cells",
    );
    assert(
      desktopTableLayout.rowIndexWidth <= 56 &&
        desktopTableLayout.actionWidth <= 40,
      "Table utility columns stay compact",
    );
    assert(
      desktopTableLayout.contentHeight <= desktopTableLayout.visibleHeight + 1,
      "Wrapped text is fully visible without an inner scrollbar",
    );
    assert.equal(
      await firstTableField.inputValue(),
      tableText,
      "Soft wrapping preserves the original text",
    );
    assert.equal(
      (await firstTableField.boundingBox()).height,
      (await secondTableField.boundingBox()).height,
      "Inputs fill the whole row height",
    );
    if (process.env.UI_TABLE_CAPTURE)
      await singleColumn.screenshot({ path: process.env.UI_TABLE_CAPTURE });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction((id) => {
      const area = document.querySelector(
        `[data-cell="${id}"] [data-grid-row="1"][data-grid-col="0"]`,
      );
      return (
        area.scrollHeight <= area.clientHeight + 1 && area.clientHeight > 100
      );
    }, singleColumnId);
    assert(
      (await firstTableField.boundingBox()).height > desktopTableLayout.height,
      "Table rows adapt when columns become narrower",
    );
    const mobileTableLayout = await firstTableField.evaluate((area) => ({
      fieldWidth: area.getBoundingClientRect().width,
      cellWidth: area.closest("td").getBoundingClientRect().width,
      tableWidth: area.closest("table").getBoundingClientRect().width,
      minimumWidth: getComputedStyle(area.closest("table")).minWidth,
    }));
    assert(
      mobileTableLayout.fieldWidth >= 218,
      "Mobile columns keep enough width for reading: " +
        JSON.stringify(mobileTableLayout),
    );
    assert(
      await singleColumn
        .locator(".nb-data-grid")
        .evaluate((grid) => grid.scrollWidth > grid.clientWidth),
      "Mobile tables offer horizontal scrolling",
    );
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "Wide tables scroll inside the grid on mobile",
    );
    if (process.env.UI_TABLE_MOBILE_CAPTURE)
      await singleColumn.screenshot({
        path: process.env.UI_TABLE_MOBILE_CAPTURE,
      });
    const stableGridAction = async (action, { row, column } = {}) => {
      const selector = `[data-nb="${action}"]${row ? `[data-row="${row}"]` : ""}${column !== undefined ? `[data-column="${column}"]` : ""}`;
      const button = singleColumn.locator(selector);
      await button.scrollIntoViewIfNeeded();
      const before = await singleColumn.evaluate((cell, setScroll) => {
        const grid = cell.querySelector(".nb-data-grid");
        if (setScroll) {
          grid.scrollTop = Math.min(180, grid.scrollHeight - grid.clientHeight);
          grid.scrollLeft = Math.min(100, grid.scrollWidth - grid.clientWidth);
        }
        return {
          outer: cell.closest("#detail").scrollTop,
          top: grid.scrollTop,
          left: grid.scrollLeft,
        };
      }, !action.includes("delete"));
      if (action.includes("delete"))
        page.once("dialog", (dialog) => dialog.accept());
      await button.click();
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const after = await singleColumn.evaluate((cell) => {
        const grid = cell.querySelector(".nb-data-grid");
        return {
          outer: cell.closest("#detail").scrollTop,
          top: grid.scrollTop,
          left: grid.scrollLeft,
          maxTop: grid.scrollHeight - grid.clientHeight,
          maxLeft: grid.scrollWidth - grid.clientWidth,
          maxOuter:
            cell.closest("#detail").scrollHeight -
            cell.closest("#detail").clientHeight,
        };
      });
      assert(
        Math.abs(after.outer - Math.min(before.outer, after.maxOuter)) <= 2,
        `${action} moved the notebook: ${JSON.stringify({ before, after })}`,
      );
      assert(
        Math.abs(after.top - Math.min(before.top, after.maxTop)) <= 2,
        `${action} lost table vertical position: ${JSON.stringify({ before, after })}`,
      );
      assert(
        Math.abs(after.left - Math.min(before.left, after.maxLeft)) <= 2,
        `${action} lost table horizontal position: ${JSON.stringify({ before, after })}`,
      );
    };
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 2560, height: 1440 },
      { width: 1440, height: 2560 },
    ]) {
      await page.setViewportSize(viewport);
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      await stableGridAction("grid-add-row");
      await stableGridAction("grid-delete-row", { row: 3 });
      await stableGridAction("grid-add-column");
      await stableGridAction("grid-delete-column", { column: 2 });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await firstTableField.fill("");
    await secondTableField.fill("");
    assert(
      (await firstTableField.boundingBox()).height <= 52,
      "Empty rows shrink back after clearing text",
    );
    page.once("dialog", (dialog) => dialog.accept());
    await singleColumn.locator('[data-nb="grid-delete-column"]').last().click();
    page.once("dialog", (dialog) => dialog.accept());
    await singleColumn.locator('[data-nb="grid-delete-row"]').last().click();
    assert.match(await singleColumn.innerText(), /1 行 × 1 列/);
    const singleColumnSaved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().includes("/api/records/") &&
        response.status() === 200,
    );
    await singleColumn.locator('[data-nb="grid-add-row"]').click();
    assert.match(await singleColumn.innerText(), /2 行 × 1 列/);
    await singleColumn.locator('[data-nb="grid-add-row"]').click();
    assert.match(await singleColumn.innerText(), /3 行 × 1 列/);
    await singleColumnSaved;
    await page.locator('[data-save-status][data-state="saved"]').waitFor();
    await page.reload();
    await page.locator("[data-action=select]").first().click();
    assert.match(
      await page.locator(`[data-cell="${singleColumnId}"]`).innerText(),
      /3 行 × 1 列/,
    );

    await page.setViewportSize({ width: 1440, height: 1000 });
    await singleColumn.locator('[data-nb="grid-add-column"]').click();
    const field = (r, c) =>
      singleColumn.locator(`[data-grid-row="${r}"][data-grid-col="${c}"]`);
    await field(0, 0).fill("步骤");
    await field(0, 1).fill("说明");
    const copiedParagraphs = '第一段\n\n第二段，含"引号"与\t制表符';
    const copyRows = [
      ["第一项", copiedParagraphs],
      ["第二项", "不选择这一行"],
      ["第三项", "末项"],
    ];
    for (let r = 0; r < copyRows.length; r++) {
      for (let c = 0; c < 2; c++) await field(r + 1, c).fill(copyRows[r][c]);
    }
    const { parseCSV } = await import("../static/notebook-core.mjs");
    const clipboardRows = async () =>
      parseCSV(await page.evaluate(() => navigator.clipboard.readText()), "\t");
    const insertSelected = async (side) => {
      await singleColumn.locator("[data-grid-insert-menu] > summary").click();
      await singleColumn.locator(`[data-nb="grid-insert-${side}"]`).click();
      assert.equal(
        await singleColumn
          .locator("[data-grid-insert-menu]")
          .getAttribute("open"),
        null,
      );
    };
    await singleColumn
      .locator('[data-nb="grid-select-row"][data-row="1"]')
      .click();
    await singleColumn
      .locator('[data-nb="grid-select-row"][data-row="3"]')
      .click({ modifiers: ["Shift"] });
    assert.equal(
      await singleColumn
        .locator('[data-nb="grid-select-row"][aria-pressed="true"]')
        .count(),
      3,
    );
    await singleColumn
      .locator('[data-nb="grid-select-row"][data-row="2"]')
      .click();
    await singleColumn.locator('[data-nb="grid-copy"]').click();
    assert.deepEqual(await clipboardRows(), [copyRows[0], copyRows[2]]);
    await singleColumn.locator("[data-grid-copy-options] > summary").click();
    await singleColumn.locator("[data-grid-copy-header]").check();
    await singleColumn.locator('[data-nb="grid-copy"]').click();
    assert.deepEqual(await clipboardRows(), [
      ["步骤", "说明"],
      copyRows[0],
      copyRows[2],
    ]);
    await insertSelected("before");
    assert.equal(await field(1, 0).inputValue(), "");
    assert.equal(await field(2, 0).inputValue(), "第一项");
    await insertSelected("after");
    assert.equal(await field(2, 0).inputValue(), "");
    assert.equal(await field(3, 0).inputValue(), "第一项");
    assert.match(await singleColumn.innerText(), /5 行 × 2 列/);
    await singleColumn.locator('[data-nb="grid-clear-selection"]').click();
    await singleColumn
      .locator('[data-nb="grid-select-column"][data-column="0"]')
      .click();
    await singleColumn
      .locator('[data-nb="grid-select-column"][data-column="1"]')
      .click();
    await insertSelected("before");
    assert.equal(await field(0, 0).inputValue(), "新列");
    assert.equal(await field(0, 1).inputValue(), "步骤");
    await insertSelected("after");
    assert.equal(await field(0, 1).inputValue(), "新列");
    assert.equal(await field(0, 2).inputValue(), "步骤");
    assert.equal(await field(0, 3).inputValue(), "说明");
    await singleColumn.locator('[data-nb="grid-clear-selection"]').click();
    await singleColumn
      .locator('[data-nb="grid-select-column"][data-column="2"]')
      .click();
    await singleColumn
      .locator('[data-nb="grid-select-column"][data-column="3"]')
      .click();
    await page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: undefined,
      }),
    );
    await singleColumn.locator('[data-nb="grid-copy"]').click();
    await page.evaluate(() => delete navigator.clipboard);
    assert.deepEqual(await clipboardRows(), [
      ["步骤", "说明"],
      ["", ""],
      ["", ""],
      ...copyRows,
    ]);
    await page.locator('[data-save-status][data-state="saved"]').waitFor();
    await page.reload();
    await page.locator("[data-action=select]").first().click();
    assert.match(await singleColumn.innerText(), /5 行 × 4 列/);
    assert.equal(await field(3, 3).inputValue(), copiedParagraphs);
    assert(await singleColumn.locator('[data-nb="grid-copy"]').isDisabled());
    await singleColumn
      .locator('[data-nb="grid-select-row"][data-row="3"]')
      .click();
    await singleColumn
      .locator('[data-nb="grid-select-row"][data-row="5"]')
      .click();
    page.once("dialog", (dialog) => dialog.accept());
    await singleColumn
      .locator('[data-nb="grid-delete-row"][data-row="1"]')
      .click();
    assert.equal(
      await singleColumn
        .locator('[data-nb="grid-select-row"][data-row="2"]')
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(
      await singleColumn
        .locator('[data-nb="grid-select-row"][data-row="4"]')
        .getAttribute("aria-pressed"),
      "true",
    );
    await singleColumn.locator('[data-nb="grid-copy"]').click();
    assert.deepEqual(await clipboardRows(), [
      ["", "", ...copyRows[0]],
      ["", "", ...copyRows[2]],
    ]);
    page.once("dialog", (dialog) => dialog.accept());
    await singleColumn
      .locator('[data-nb="grid-delete-row"][data-row="2"]')
      .click();
    await singleColumn.locator('[data-nb="grid-copy"]').click();
    assert.deepEqual(await clipboardRows(), [["", "", ...copyRows[2]]]);
    const pagedCSV =
      "编号,备注\n" +
      Array.from({ length: 70 }, (_, i) => `${i + 1},备注 ${i + 1}`).join("\n");
    page.once("dialog", (dialog) => dialog.accept());
    await singleColumn.locator("[data-csv-input]").setInputFiles({
      name: "selection.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(pagedCSV, "utf8"),
    });
    await page.waitForFunction(
      (id) =>
        document
          .querySelector(`[data-cell="${id}"]`)
          .innerText.includes("70 行 × 2 列"),
      singleColumnId,
    );
    assert(await singleColumn.locator('[data-nb="grid-copy"]').isDisabled());
    await singleColumn
      .locator('[data-nb="grid-select-row"][data-row="1"]')
      .click();
    await singleColumn.locator('[data-nb="grid-next"]').click();
    await singleColumn
      .locator('[data-nb="grid-select-row"][data-row="51"]')
      .click();
    await singleColumn.locator('[data-nb="grid-copy"]').click();
    assert.deepEqual(await clipboardRows(), [
      ["1", "备注 1"],
      ["51", "备注 51"],
    ]);
    await singleColumn
      .locator('[data-nb="grid-select-column"][data-column="1"]')
      .click();
    await singleColumn.locator('[data-nb="grid-copy"]').click();
    const allColumnRows = await clipboardRows();
    assert.equal(
      allColumnRows.length,
      71,
      "Copying a column includes data on other pages",
    );
    assert.deepEqual(allColumnRows[0], ["备注"]);
    assert.deepEqual(allColumnRows.at(-1), ["备注 70"]);
    await singleColumn
      .locator('[data-nb="grid-select-row"][data-row="51"]')
      .click();
    await insertSelected("before");
    assert.equal(await field(51, 0).inputValue(), "");
    assert.equal(await field(52, 0).inputValue(), "51");
    await insertSelected("after");
    assert.equal(await field(52, 0).inputValue(), "");
    assert.equal(await field(53, 0).inputValue(), "51");
    assert.match(await singleColumn.innerText(), /72 行 × 2 列/);
    await singleColumn.locator("[data-grid-copy-options] > summary").click();
    const copyMenu = await singleColumn
      .locator("[data-grid-copy-options] .nb-grid-menu-panel")
      .boundingBox();
    assert(copyMenu.x >= 0 && copyMenu.x + copyMenu.width <= 1440);
    await page.keyboard.press("Escape");
    assert.equal(
      await singleColumn
        .locator("[data-grid-copy-options]")
        .getAttribute("open"),
      null,
    );
    if (process.env.UI_TABLE_SELECTION_CAPTURE)
      await singleColumn.screenshot({
        path: process.env.UI_TABLE_SELECTION_CAPTURE,
      });
    await page.setViewportSize({ width: 390, height: 844 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await singleColumn.locator("[data-grid-insert-menu] > summary").click();
    const mobileMenu = await singleColumn
      .locator("[data-grid-insert-menu] .nb-grid-menu-panel")
      .boundingBox();
    assert(mobileMenu.x >= 0 && mobileMenu.x + mobileMenu.width <= 390);
    await page.keyboard.press("Escape");
    if (process.env.UI_TABLE_SELECTION_MOBILE_CAPTURE)
      await singleColumn.screenshot({
        path: process.env.UI_TABLE_SELECTION_MOBILE_CAPTURE,
      });

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
      "PASS: multi-account creation/isolation/disable; login, persistent session, expired-session draft recovery, password change and logout; 8 viewport widths; focus mode; menus; Markdown selection, lists and manual modes; mobile navigation; workspace switch; table overflow; visual Markdown/table/math/Mermaid editing, export and save/reload; no JS page errors.",
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
