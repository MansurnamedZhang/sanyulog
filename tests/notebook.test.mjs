import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
const location = new URL("../static/notebook-core.mjs", import.meta.url);
const exists = existsSync(location);
const core = exists ? await import(location) : {};

test("notebook core exists", () =>
  assert.ok(exists, "Notebook core not implemented"));
test("CSV table preserves commas, quotes, multiline values, BOM and empty cells", () => {
  assert.equal(typeof core.parseCSV, "function");
  const rows = core.parseCSV(
    '\uFEFF名称,备注,数值\r\nA,"a,b\n""quoted""",\r\n',
  );
  assert.deepEqual(rows, [
    ["名称", "备注", "数值"],
    ["A", 'a,b\n"quoted"', ""],
  ]);
  assert.deepEqual(core.parseCSV(core.serializeCSV(rows)), rows);
  assert.throws(() => core.parseCSV('a,"broken'));
});
test("table template has requested columns and body rows", () => {
  assert.equal(typeof core.createTable, "function");
  const result = core.createTable(2, 3);
  assert.equal(result.trim().split("\n").length, 4);
  assert.equal((core.renderMarkdown(result).match(/<th>/g) || []).length, 3);
  assert.equal((core.renderMarkdown(result).match(/<td>/g) || []).length, 6);
  assert.throws(() => core.createTable(0, 3));
});
test("spreadsheet paste preserves quoted cells, pipes and empty trailing fields", () => {
  assert.equal(typeof core.tsvToTable, "function");
  const md = core.tsvToTable('名称\t备注\t数值\r\nA\t"a|b\n第二行"\t\r\n');
  const html = core.renderMarkdown(md);
  assert.ok(html.includes("a&#124;b<br>第二行"));
  assert.equal((html.match(/<td>/g) || []).length, 3);
  assert.equal(core.tsvToTable("普通文字"), null);
  assert.ok(
    !core.renderMarkdown(core.tsvToTable("A\tB\n<img>\t$x$")).includes("<math"),
  );
});
test("format tools wrap selection and select inserted placeholder", () => {
  assert.equal(typeof core.formatSelection, "function");
  assert.deepEqual(core.formatSelection("hello world", 6, 11, "bold"), {
    text: "hello **world**",
    start: 8,
    end: 13,
  });
  const result = core.formatSelection("", 0, 0, "math");
  assert.equal(result.text, "$x^2$");
  assert.equal(result.text.slice(result.start, result.end), "x^2");
  assert.equal(core.formatSelection("code", 0, 4, "code").text, "`code`");
});
test("LaTeX renders inline and display math, but not inside code", () => {
  assert.match(core.renderMarkdown("公式 $x^2$"), /<math/);
  assert.match(core.renderMarkdown("$$\n\\frac{1}{2}\n$$"), /display="block"/);
  assert.ok(!core.renderMarkdown("`$x$`").includes("<math"));
  assert.ok(!core.renderMarkdown("```\n$x$\n```").includes("<math"));
  assert.ok(!core.renderMarkdown("价格 \\$5").includes("<math"));
  assert.doesNotThrow(() => core.renderMarkdown("$\\frac{$"));
});
test("Mermaid fences keep diagram text escaped and leave CSS code alone", () => {
  const diagram = core.renderMarkdown(
    "```mermaid\nflowchart TD\nU[客户文字与输入图] --> API[接口服务]\n```",
  );
  assert.match(diagram, /class="nb-mermaid"/);
  assert.match(diagram, /flowchart TD/);
  assert.match(diagram, /客户文字与输入图/);
  assert.ok(!diagram.includes("<svg"));
  const unsafe = core.renderMarkdown(
    "```mermaid\nflowchart TD\nA[<img src=x onerror=alert(1)>] --> B\n```",
  );
  assert.ok(!unsafe.includes("<img"));
  assert.match(unsafe, /&lt;img/);
  assert.ok(
    core
      .renderMarkdown("```css\na { color: red }\n```")
      .includes("<pre><code>"),
  );
});
test("Mermaid toolbar wraps a selected flowchart and fixes an accidental CSS fence", () => {
  const pasted =
    "flowchart TD\nU --> API\n```css\nsubgraph S\n API --> P\nend\n```";
  const result = core.formatSelection(pasted, 0, pasted.length, "mermaid");
  assert.equal(
    result.text.trim(),
    "```mermaid\nflowchart TD\nU --> API\nsubgraph S\n API --> P\nend\n```",
  );
  assert.equal(
    result.text.slice(result.start, result.end),
    "flowchart TD\nU --> API\nsubgraph S\n API --> P\nend",
  );
});
test(
  "IDs work with getRandomValues when randomUUID is unavailable over LAN HTTP",
  { skip: !exists },
  () => {
    assert.equal(typeof core.newId, "function");
    const id = core.newId({
      getRandomValues: (array) => {
        array.fill(31);
        return array;
      },
    });
    assert.match(id, /^[a-f0-9]{32}$/);
    assert.equal(id, "1f".repeat(16));
  },
);
test(
  "Markdown supports headings, tables, lists, links and code safely",
  { skip: !exists },
  () => {
    const html = core.renderMarkdown(
      '# 标题\n\n| 参数 | 值 |\n| --- | --- |\n| lr | 0.001 |\n\n- 第一项\n- 第二项\n\n[文档](https://example.com)\n\n```python\n    print("x")\n```',
    );
    for (const part of [
      "<h1>标题</h1>",
      "<table>",
      "<td>0.001</td>",
      "<li>第一项</li>",
      'href="https://example.com"',
      "    print(&quot;x&quot;)",
    ])
      assert.ok(html.includes(part), part);
    const hostile = core.renderMarkdown(
      "<img src=x onerror=alert(1)>\n\n[x](javascript:alert)\n\n![remote](https://example.com/a.png)",
    );
    assert.ok(!hostile.includes("<img"));
    assert.ok(!hostile.includes('href="javascript:'));
    assert.ok(hostile.includes("&lt;img"));
  },
);
test(
  "autosave serializes input arriving while an older snapshot saves",
  { skip: !exists },
  async () => {
    let resolveFirst;
    const sent = [],
      persisted = [];
    const queue = new core.Autosave({
      initial: { version: 1, title: "start" },
      delay: 100000,
      save: async (data) => {
        sent.push(structuredClone(data));
        if (sent.length === 1) await new Promise((r) => (resolveFirst = r));
        return { ...data, version: data.version + 1 };
      },
      persist: (data) => persisted.push(structuredClone(data)),
    });
    queue.change({ title: "first" });
    const saving = queue.flush();
    queue.change({ title: "second" });
    resolveFirst();
    await saving;
    assert.deepEqual(
      sent.map((x) => [x.title, x.version]),
      [
        ["first", 1],
        ["second", 2],
      ],
    );
    assert.equal(queue.data.title, "second");
    assert.equal(queue.data.version, 3);
    assert.equal(queue.dirty, false);
    assert.equal(persisted.at(-1), null);
    queue.dispose();
  },
);
test(
  "failed saves keep drafts and can be retried without losing text",
  { skip: !exists },
  async () => {
    let fail = true,
      draft;
    const queue = new core.Autosave({
      initial: { version: 1, title: "old" },
      delay: 100000,
      persist: (d) => (draft = d),
      save: async (d) => {
        if (fail) throw new Error("offline");
        return { ...d, version: 2 };
      },
    });
    queue.change({ title: "still here" });
    await assert.rejects(queue.flush(), /offline/);
    assert.equal(draft.title, "still here");
    assert.equal(queue.dirty, true);
    fail = false;
    await queue.flush();
    assert.equal(queue.data.title, "still here");
    assert.equal(draft, null);
    queue.dispose();
  },
);
test(
  "conflict does not silently retry with a newer version",
  { skip: !exists },
  async () => {
    let calls = 0;
    const queue = new core.Autosave({
      initial: { version: 1 },
      delay: 100000,
      save: async () => {
        calls++;
        throw Object.assign(new Error("conflict"), { status: 409 });
      },
    });
    queue.change({ title: "draft" });
    await assert.rejects(queue.flush(), /conflict/);
    queue.change({ title: "more" });
    await assert.rejects(queue.flush(), /conflict/);
    assert.equal(calls, 1);
    assert.equal(queue.data.title, "more");
    assert.equal(queue.dirty, true);
    queue.dispose();
  },
);

test("independent table view escapes values and paginates data rows", async () => {
  const { Notebook } = await import(
    new URL("../static/notebook.js", import.meta.url)
  );
  const notebook = Object.create(Notebook.prototype);
  notebook.tablePages = new Map();
  const cell = {
    id: "a",
    source: core.serializeCSV([
      ["<script>", "value"],
      ...Array.from({ length: 51 }, (_, i) => [String(i), ""]),
    ]),
  };
  const first = notebook.tableHTML(cell);
  assert.ok(first.includes("&lt;script&gt;"));
  assert.ok(!first.includes("<script>"));
  assert.ok(first.includes('data-grid-row="50"'));
  assert.ok(!first.includes('data-grid-row="51"'));
  notebook.tablePages.set("a", 1);
  assert.ok(notebook.tableHTML(cell).includes('data-grid-row="51"'));
  assert.deepEqual(notebook.tableRows({ source: "a,b\n1" }), [
    ["a", "b"],
    ["1", ""],
  ]);
});

test("list formatting acts on complete selected lines and preserves boundaries", () => {
  const source = "前言\n手\n发丝\n服装褶皱\n后文";
  const result = core.formatSelection(
    source,
    4,
    source.indexOf("后文"),
    "unordered",
  );
  assert.equal(result.text, "前言\n- 手\n- 发丝\n- 服装褶皱\n后文");
  assert.equal(
    core.formatSelection("手\n\n发丝", 0, 5, "ordered").text,
    "1. 手\n\n2. 发丝",
  );
  assert.equal(
    core.formatSelection("- 手\n- 发丝", 0, 8, "ordered").text,
    "1. 手\n2. 发丝",
  );
  const nested = core.formatSelection("- 对比\n- 手\n- 发丝", 5, 13, "indent");
  assert.equal(nested.text, "- 对比\n    - 手\n    - 发丝");
  assert.equal(
    core.formatSelection(nested.text, nested.start, nested.end, "outdent").text,
    "- 对比\n- 手\n- 发丝",
  );
  assert.equal(core.formatSelection("abc", 1, 1, "unordered").text, "- abc");
});
test("Markdown renders mixed nested lists inside parent items", () => {
  assert.equal(
    core.renderMarkdown("- 对比\n    - 手\n    - 发丝\n- 结果"),
    "<ul><li>对比<ul><li>手</li><li>发丝</li></ul></li><li>结果</li></ul>",
  );
  assert.equal(
    core.renderMarkdown("3. 父项\n    - 子项\n        1. 孙项\n4. 下一项"),
    '<ol start="3"><li>父项<ul><li>子项<ol><li>孙项</li></ol></li></ul></li><li>下一项</li></ol>',
  );
  assert.equal(
    core.renderMarkdown("- 一\n\n- 二\n\n正文"),
    "<ul><li>一</li><li>二</li></ul><p>正文</p>",
  );
});

test("grid paste keeps paragraphs in one cell and still accepts Excel regions", async () => {
  const { Notebook } = await import(
    new URL("../static/notebook.js", import.meta.url)
  );
  const notebook = Object.create(Notebook.prototype);
  const cell = {
    id: "a",
    type: "table",
    source: core.serializeCSV([
      ["标题", "备注"],
      ["原文", "保留"],
      ["下一行", "不覆盖"],
    ]),
  };
  notebook.cell = () => cell;
  notebook.queue = { data: { cells: [cell] }, change() {} };
  notebook.renderCells = () => {};
  notebook.toast = (message) => {
    throw new Error(message);
  };
  const area = {
    dataset: { gridRow: "1", gridCol: "0" },
    closest: (selector) =>
      selector === "[data-cell]" ? { dataset: { cell: "a" } } : null,
    matches: (selector) => selector === "[data-grid-row]",
  };
  const paste = (text, html = "") => {
    let prevented = false;
    notebook.paste({
      target: area,
      clipboardData: {
        getData: (type) => (type === "text/plain" ? text : html),
        files: [],
      },
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {},
    });
    return prevented;
  };
  const paragraphs = '第一段，含标点\n\n第二段,含逗号和"引号"\n第三段';
  const original = cell.source;
  assert.equal(
    paste(paragraphs),
    false,
    "ordinary paragraphs use native textarea paste",
  );
  assert.equal(
    cell.source,
    original,
    "paste must not overwrite neighboring rows",
  );
  area.value = paragraphs;
  notebook.input({ target: area, stopPropagation() {} });
  assert.deepEqual(core.parseCSV(cell.source), [
    ["标题", "备注"],
    [paragraphs, "保留"],
    ["下一行", "不覆盖"],
  ]);
  assert.equal(paste('A\t"第一段\n第二段"\r\nB\tC'), true);
  assert.deepEqual(core.parseCSV(cell.source).slice(1), [
    ["A", "第一段\n第二段"],
    ["B", "C"],
  ]);
  assert.equal(
    paste(
      "甲\r\n乙",
      "<table><tr><td>甲</td></tr><tr><td>乙</td></tr></table>",
    ),
    true,
  );
  assert.equal(core.parseCSV(cell.source)[2][0], "乙");
});

test("visual table line breaks render safely in exported Markdown", () => {
  const rendered = core.renderMarkdown(
    "| 名称 | 备注 |\n| --- | --- |\n| 第一段<br>第二段<br><br>第三段 | <script>alert(1)</script> |",
  );
  assert.ok(rendered.includes("第一段<br>第二段<br><br>第三段"));
  assert.ok(!rendered.includes("<script>"));
});
