const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanyu-database-ui-"));
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
        () => reject(new Error("Fixture timeout")),
        15000,
      );
      fixture.stdout.on("data", (chunk) => {
        output += chunk;
        const m = output.match(/UI_READY:(\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
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
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}`);
    await page.locator('[name="username"]').fill("admin");
    await page.locator('[name="password"]').fill("ui-test-password-only");
    await page.locator("#login-form button").click();
    await page
      .locator(".record-card")
      .filter({ hasText: "视频数据配比与训练记录" })
      .first()
      .click();
    const snapshot = async () =>
      page.evaluate(async () => {
        const s = await (await fetch("/api/state")).json();
        return s.records.find((r) => r.title === "视频数据配比与训练记录");
      });
    const originalTable = (await snapshot()).cells.find(
      (c) => c.type === "table",
    );
    await page
      .locator('.nb-toolbar [data-type="database"]')
      .click({ timeout: 3000 });
    const block = page.locator(".sdb").last();
    await block.locator("[data-db-title]").fill("训练数据库");
    const addProperty = async (name, type, options = []) => {
      await block.locator('[data-db="add-property"]').first().click();
      const dialog = page.locator(".sdb-property-dialog");
      await dialog.locator('[name="name"]').fill(name);
      await dialog.locator('[name="type"]').selectOption(type);
      for (const [label, color] of options) {
        await dialog.locator('[data-prop="add-option"]').click();
        await dialog.locator("[data-option-label]").last().fill(label);
        await dialog.locator("[data-option-color]").last().selectOption(color);
      }
      await dialog
        .getByRole("button", { name: "保存属性", exact: true })
        .click();
      await dialog.waitFor({ state: "detached" });
    };
    await addProperty("评分", "number");
    await addProperty("日期", "date");
    await addProperty("验证", "checkbox");
    await block.locator('[data-db="add-row"]').first().click();
    const row = block.locator("[data-db-record]").first();
    const text = row.locator("textarea[data-db-input]").first(),
      paragraphs = "基线实验\n第二段，粘贴不会拆行";
    await text.fill(paragraphs);
    await row.locator('input[type="number"]').fill("8.5");
    await row.locator('input[type="date"]').fill("2026-10-13");
    await row.locator('input[type="checkbox"][data-db-input]').check();
    await row.locator('[data-db="choose"]').first().click();
    await page
      .locator(".sdb-picker")
      .getByRole("button", { name: "进行中", exact: true })
      .click();
    await row.locator('[data-db="choose"]').nth(1).click();
    const picker = page.locator(".sdb-picker");
    for (const value of ["LoRA", "对照"]) {
      await picker.locator("[data-choice-search]").fill(value);
      await picker.locator('[data-choice="create"]').click();
    }
    await picker.getByRole("button", { name: "完成选择", exact: true }).click();
    assert.equal(await row.locator(".sdb-tag").count(), 3);
    await block.locator('[data-db="add-row"]').first().click();
    await block
      .locator("[data-db-record]")
      .nth(1)
      .locator("textarea")
      .fill("对照实验");
    await block
      .locator("[data-db-record]")
      .nth(1)
      .locator('input[type="number"]')
      .fill("10");
    // Property rename and reorder preserve chosen option IDs.
    await block.locator('[data-db="properties"]').click();
    let list = page.locator(".sdb-properties-dialog");
    await list.locator('[data-prop="edit"]').nth(1).click();
    let property = page.locator(".sdb-property-dialog");
    await property.locator('[name="name"]').fill("进度");
    await property.locator("[data-option-label]").nth(1).fill("处理中");
    await property.locator("[data-option-color]").nth(1).selectOption("orange");
    await property
      .getByRole("button", { name: "保存属性", exact: true })
      .click();
    await list.locator('[data-prop="right"]').nth(1).click();
    await list.getByRole("button", { name: "完成", exact: true }).click();
    assert.equal(await row.locator(".sdb-tag-orange").textContent(), "处理中");
    // Cancelled property edits do not alter source.
    await block.locator('[data-db="property"]').first().click();
    property = page.locator(".sdb-property-dialog");
    await property.locator('[name="name"]').fill("不应保存");
    await property.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(
      await block.locator('thead [data-db="property"]').first().innerText(),
      "Aa 名称 ⌄",
    );
    // Persistent numeric sorting and choice filtering.
    await block.locator('[data-db="sort"]').click();
    let view = page.locator(".sdb-view-dialog");
    await view.locator('[name="column"]').selectOption({ label: "评分" });
    await view.locator('[name="direction"]').selectOption("desc");
    await view.getByRole("button", { name: "应用", exact: true }).click();
    assert.equal(
      await block
        .locator("[data-db-record]")
        .first()
        .locator("textarea")
        .inputValue(),
      "对照实验",
    );
    await block.locator('[data-db="filter"]').click();
    view = page.locator(".sdb-view-dialog");
    await view.locator('[name="column"]').selectOption({ label: "进度" });
    await view.locator('[name="value"]').selectOption({ label: "处理中" });
    await view.getByRole("button", { name: "应用", exact: true }).click();
    assert.equal(await block.locator("[data-db-record]").count(), 1);
    await block.locator("[data-db-search]").fill("第二段");
    assert.equal(await block.locator("[data-db-record]").count(), 1);
    await block.locator("[data-db-search]").fill("");
    await page.keyboard.press("Control+s");
    await page.waitForFunction(
      () =>
        document.querySelector("[data-save-status]")?.textContent ===
        "所有修改已保存",
    );
    let saved = await snapshot(),
      data = JSON.parse(saved.cells.find((c) => c.type === "database").source);
    assert.deepEqual(
      saved.cells.find((c) => c.type === "table"),
      originalTable,
    );
    assert.equal(data.rows[0].values[data.columns[0].id], paragraphs);
    assert.equal(
      data.rows[0].values[
        data.columns.find((c) => c.type === "multi-select").id
      ].length,
      2,
    );
    assert.equal(
      data.rows[0].values[data.columns.find((c) => c.type === "checkbox").id],
      true,
    );
    await page.reload();
    await block.waitFor();
    assert.equal(await block.locator("[data-db-record]").count(), 1);
    assert.equal(
      await block.locator("[data-db-title]").inputValue(),
      "训练数据库",
    );
    assert.equal(
      await block.locator(".sdb-tag-orange").textContent(),
      "处理中",
    );
    // Editing a filtered/sorted row keeps DOM focus and row position.
    const stableRow = block.locator("[data-db-record]").first();
    const rowId = await stableRow.getAttribute("data-db-record");
    await stableRow.locator("textarea").fill(paragraphs + "\n继续编辑");
    await stableRow.locator('input[type="number"]').click();
    assert.equal(await stableRow.getAttribute("data-db-record"), rowId);
    assert.equal(
      await stableRow
        .locator('input[type="number"]')
        .evaluate((el) => el === document.activeElement),
      true,
    );
    await block.locator('[data-db="refresh-view"]').click();
    if (process.env.UI_SCREENSHOTS) {
      fs.mkdirSync(process.env.UI_SCREENSHOTS, { recursive: true });
      for (const [width, height] of [
        [390, 1000],
        [2560, 1440],
      ]) {
        await page.setViewportSize({ width, height });
        await block
          .locator(".sdb-scroll")
          .evaluate((el) => (el.scrollLeft = 0));
        await block.evaluate((el) => {
          const detail = el.closest(".detail");
          detail.scrollTop +=
            el.getBoundingClientRect().top -
            detail.getBoundingClientRect().top -
            170;
        });
        await page.screenshot({
          path: path.join(process.env.UI_SCREENSHOTS, `preview-${width}.png`),
        });
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    const downloadPromise = page.waitForEvent("download");
    await block.locator('[data-db="export"]').click();
    const download = await downloadPromise;
    const csv = fs.readFileSync(await download.path(), "utf8");
    assert.match(csv, /对照实验/);
    assert.match(csv, /LoRA/);
    assert.match(csv, /第二段/);
    // Multiselect deletion and property deletion apply by stable IDs.
    await block.locator('[data-db="clear-view"]').click();
    const colorPopupPromise = page.waitForEvent("popup");
    await page.locator('[data-nb="export-notebook-pdf"]').click();
    const colorPopup = await colorPopupPromise;
    await colorPopup.locator(".sdb-export .sdb-tag-orange").waitFor();
    const colorPDF = await colorPopup.pdf({
      format: "A4",
      printBackground: true,
    });
    assert(colorPDF.length > 5000);
    await colorPopup.close();
    await block.locator('[data-db="add-row"]').first().click();
    await block.locator("[data-db-select-row]").first().check();
    await block.locator("[data-db-select-row]").nth(1).check();
    await block.locator('[data-db="copy"]').click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(copied, /LoRA/);
    assert.match(copied, /对照实验/);
    page.once("dialog", (d) => d.accept());
    await block.locator('[data-db="delete-selected"]').click();
    assert.equal(await block.locator("[data-db-record]").count(), 1);
    await block.locator('[data-db="properties"]').click();
    list = page.locator(".sdb-properties-dialog");
    page.once("dialog", (d) => d.accept());
    await list.locator('[data-prop="delete"]').last().click();
    await list.getByRole("button", { name: "完成", exact: true }).click();
    assert.equal(await block.locator('thead [data-db="property"]').count(), 5);
    for (const [width, height] of [
      [320, 900],
      [390, 844],
      [1440, 2560],
      [1440, 1000],
      [2560, 1440],
    ]) {
      await page.setViewportSize({ width, height });
      await block.scrollIntoViewIfNeeded();
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `page overflow ${width}`,
      );
      const before = await page
        .locator(".detail")
        .evaluate((el) => el.scrollTop);
      await block.locator('[data-db="add-row"]').first().click();
      const after = await page
        .locator(".detail")
        .evaluate((el) => el.scrollTop);
      assert(
        Math.abs(after - before) < 5,
        `add-row jump ${width}: ${before}->${after}`,
      );
      await block.locator('[data-db="add-property"]').first().click();
      property = page.locator(".sdb-property-dialog");
      const box = await property.boundingBox();
      assert(box.x >= 0 && box.x + box.width <= width + 1);
      await property.getByRole("button", { name: "取消", exact: true }).click();
      const screenshots = process.env.UI_SCREENSHOTS;
      if (screenshots) {
        fs.mkdirSync(screenshots, { recursive: true });
        await page.screenshot({
          path: path.join(screenshots, `database-${width}x${height}.png`),
        });
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    const popupPromise = page.waitForEvent("popup");
    await page.locator('[data-nb="export-notebook-pdf"]').click();
    const popup = await popupPromise;
    await popup.locator(".sdb-export table").waitFor();
    assert.match(await popup.locator(".sdb-export").innerText(), /训练数据库/);
    const pdf = await popup.pdf({ format: "A4", printBackground: true });
    assert(pdf.length > 5000);
    await popup.close();
    assert.deepEqual(errors, []);
    console.log(
      "Database UI passed: separate block, six types, multiline, stable IDs, choice autosave, properties, filter/sort, reload, CSV, PDF, 5 viewports; legacy table unchanged.",
    );
  } finally {
    if (browser) await browser.close();
    fixture.kill();
    await new Promise((resolve) => fixture.once("exit", resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
