import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  normalizeMermaidDefinition,
  normalizeMermaidFences,
} from "../static/mermaid-source.mjs";
const location = new URL("../static/notebook-core.mjs", import.meta.url);
const exists = existsSync(location);
const core = exists ? await import(location) : {};
const mediaBrowserPath =
  process.env.UI_BROWSER_PATH ||
  (await import("playwright")).chromium.executablePath();

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
test("single-column table preserves newly added empty rows", () => {
  const rows = [["TemplateId"], [""], [""]];
  assert.deepEqual(core.parseCSV(core.serializeCSV(rows)), rows);
});
test("TSV serialization keeps multiline, quotes, tabs and empty cells", () => {
  const rows = [
    ["名称", "备注"],
    ["A\tB", '第一段\n\n第二段,"引号"'],
    ["", ""],
  ];
  assert.deepEqual(core.parseCSV(core.serializeCSV(rows, "\t"), "\t"), rows);
});
test("table insertion preserves data, supports edges and enforces limits", () => {
  const rows = [
    ["A", "B"],
    ["一", "多段\n文字"],
    ["二", ""],
  ];
  const before = structuredClone(rows);
  assert.deepEqual(core.insertTableDimension(rows, "row", 1), [
    ["A", "B"],
    ["", ""],
    ...rows.slice(1),
  ]);
  assert.deepEqual(core.insertTableDimension(rows, "row", 3), [
    ...rows,
    ["", ""],
  ]);
  assert.deepEqual(core.insertTableDimension(rows, "column", 0), [
    ["新列", "A", "B"],
    ["", "一", "多段\n文字"],
    ["", "二", ""],
  ]);
  assert.deepEqual(core.insertTableDimension(rows, "column", 2), [
    ["A", "B", "新列"],
    ["一", "多段\n文字", ""],
    ["二", "", ""],
  ]);
  assert.deepEqual(rows, before);
  assert.throws(() => core.insertTableDimension(rows, "row", 0));
  assert.throws(() => core.insertTableDimension(rows, "column", 3));
  assert.throws(() =>
    core.insertTableDimension(
      Array.from({ length: 1001 }, () => [""]),
      "row",
      1,
    ),
  );
  assert.throws(() =>
    core.insertTableDimension([Array(50).fill("")], "column", 0),
  );
});
test("copying selected rows or columns keeps order and optional headers", () => {
  const rows = [
    ["A", "B", "C"],
    ["一", '含\t制表符与"引号"', "第一段\n第二段"],
    ["二", "保留", ""],
    ["三", "", "尾部"],
  ];
  assert.deepEqual(
    core.parseCSV(core.copyTableSelection(rows, "row", [3, 1, 1], false), "\t"),
    [rows[1], rows[3]],
  );
  assert.deepEqual(
    core.parseCSV(core.copyTableSelection(rows, "row", [2], true), "\t"),
    [rows[0], rows[2]],
  );
  assert.deepEqual(
    core.parseCSV(core.copyTableSelection(rows, "column", [2, 0], true), "\t"),
    rows.map((r) => [r[0], r[2]]),
  );
  assert.deepEqual(
    core.parseCSV(core.copyTableSelection(rows, "column", [1], false), "\t"),
    rows.slice(1).map((r) => [r[1]]),
  );
  assert.throws(() => core.copyTableSelection(rows, "row", [], false));
  assert.throws(() => core.copyTableSelection(rows, "row", [0], false));
  assert.throws(() => core.copyTableSelection(rows, "column", [3], true));
});
test("batch deletion removes disjoint rows or columns without changing retained data", () => {
  const rows = [
    ["A", "B", "C"],
    ["一", "删除", "第一段\n第二段"],
    ["二", '保留\t"文字"', ""],
    ["三", "删除", "尾部"],
  ];
  const before = structuredClone(rows);
  assert.deepEqual(core.deleteTableSelection(rows, "row", [3, 1, 1]), [
    rows[0],
    rows[2],
  ]);
  assert.deepEqual(
    core.deleteTableSelection(rows, "column", [2, 0]),
    rows.map((row) => [row[1]]),
  );
  assert.deepEqual(rows, before);
});
test("batch deletion preserves the header and at least one column", () => {
  const rows = [["表头"], ["第一段\n第二段"], [""]];
  const before = structuredClone(rows);
  const empty = core.deleteTableSelection(rows, "row", [1, 2]);
  assert.deepEqual(empty, [["表头"]]);
  assert.deepEqual(core.parseCSV(core.serializeCSV(empty)), empty);
  assert.deepEqual(core.insertTableDimension(empty, "row", 1), [
    ["表头"],
    [""],
  ]);
  for (const [axis, indices] of [
    ["row", []],
    ["row", [1, 0]],
    ["row", [1, 3]],
    ["row", [1.5]],
    ["column", [0]],
    ["column", [1]],
    ["invalid", [1]],
  ]) {
    assert.throws(() => core.deleteTableSelection(rows, axis, indices));
    assert.deepEqual(rows, before);
  }
  assert.throws(
    () =>
      core.deleteTableSelection(
        [
          ["A", "B"],
          ["一", "二"],
        ],
        "column",
        [1, 0],
      ),
    /至少保留一列/,
  );
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
test("pasted Mermaid indentation is normalized without changing labels or other code", () => {
  const diagram =
    'flowchart TD\n&#x20;   A["客户原话"] --> B["甲\\<br/>乙"]\nA --> C["&#x20;保留"]';
  const expected = diagram.replace("&#x20;   A", "    A");
  assert.equal(normalizeMermaidDefinition(diagram), expected);
  assert.equal(
    normalizeMermaidFences(
      `正文\n\`\`\`css\n&#x20; color: red\n\`\`\`\n\`\`\`mermaid\n${diagram}\n\`\`\``,
    ),
    `正文\n\`\`\`css\n&#x20; color: red\n\`\`\`\n\`\`\`mermaid\n${expected}\n\`\`\``,
  );
  const converted = core.formatSelection(diagram, 0, diagram.length, "mermaid");
  assert.equal(converted.text.slice(converted.start, converted.end), expected);
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
  notebook.tableSelections = new Map();
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
  notebook.renderTable = () => {};
  notebook.fitGridRow = () => {};
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

test("whole-notebook export includes metadata and every CSV row in order", async () => {
  const { renderNotebookHTML } = await import("../static/notebook-export.mjs");
  const rows = [
    "名称,数值",
    ...Array.from({ length: 55 }, (_, i) => `条目${i + 1},${i + 1}`),
  ].join("\n");
  const html = renderNotebookHTML(
    {
      title: "完整笔记 <测试>",
      status: "进行中",
      tags: ["实验"],
      goal: "记录全程",
      params: { rank: "32" },
      result: "已完成",
      conclusion: "继续观察",
      next_step: "复查",
      cells: [
        { type: "markdown", source: "## 第一节\n正文" },
        { type: "table", source: rows },
        { type: "code", language: "python", source: "print(1)" },
        { type: "log", source: "运行结果" },
      ],
    },
    [],
  );
  assert.match(html, /完整笔记 &lt;测试&gt;/);
  assert.match(html, /记录全程/);
  assert.match(html, /rank/);
  assert.match(html, /<h2>第一节<\/h2>/);
  assert.match(html, /条目55/);
  assert.equal((html.match(/<tr>/g) || []).length, 56);
  assert(html.indexOf("正文") < html.indexOf("条目55"));
  assert(html.indexOf("条目55") < html.indexOf("print(1)"));
  assert.match(html, /运行结果/);
  const withFiles = renderNotebookHTML(
    {
      title: "附件",
      cells: [
        { type: "file", source: "", attachment_ids: ["photo-id", "report-id"] },
      ],
    },
    [
      { id: "photo-id", name: "图像.png", mime: "image/png" },
      { id: "report-id", name: "报告.pdf", mime: "application/pdf" },
      { id: "orphan-id", name: "未插入.csv", mime: "text/csv" },
    ],
  );
  assert.match(withFiles, /<img src="\/api\/attachments\/photo-id\?preview=1"/);
  assert.match(withFiles, /报告\.pdf/);
  assert.match(withFiles, /其他附件/);
  assert.match(withFiles, /未插入\.csv/);
});

test("notebook and export render allowlisted media controls using only controlled same-origin links", async () => {
  const { Notebook } = await import("../static/notebook.js");
  const { renderNotebookHTML } = await import("../static/notebook-export.mjs");
  const attachments = [
    {
      id: "movie/id",
      name: "电影.mp4",
      mime: "video/mp4",
      size: 44,
      url: "https://private-bucket.invalid/movie",
    },
    { id: "webm-id", name: "电影.webm", mime: "video/webm", size: 44 },
    { id: "mp3-id", name: "声音.mp3", mime: "audio/mpeg", size: 44 },
    { id: "ogg-id", name: "声音.ogg", mime: "audio/ogg", size: 44 },
    {
      id: "wav-id",
      name: "<script>alert(1)</script>.wav",
      mime: "audio/wav",
      size: 44,
    },
    { id: "image-id", name: "图片.png", mime: "image/png", size: 44 },
    { id: "svg-id", name: "active.svg", mime: "image/svg+xml", size: 44 },
    { id: "html-id", name: "active.html", mime: "text/html", size: 44 },
    { id: "unknown-id", name: "data.flac", mime: "audio/flac", size: 44 },
  ];
  const ids = attachments.map((attachment) => attachment.id);
  const notebook = Object.create(Notebook.prototype);
  notebook.record = { attachments };
  const outputs = [
    notebook.filesHTML(ids),
    renderNotebookHTML(
      { cells: [{ type: "file", attachment_ids: ids }] },
      attachments,
    ),
  ];
  for (const html of outputs) {
    for (const [tag, id] of [
      ["video", "movie%2Fid"],
      ["video", "webm-id"],
      ["audio", "mp3-id"],
      ["audio", "ogg-id"],
      ["audio", "wav-id"],
    ]) {
      const element = html.match(
        new RegExp(
          `<${tag}\\b[^>]*src="/api/attachments/${id}\\?preview=1"[^>]*>`,
        ),
      );
      assert(element, `${tag} preview must use its authenticated API link`);
      assert.match(element[0], /\bcontrols\b/);
      assert.match(element[0], /preload="metadata"/);
      assert.doesNotMatch(element[0], /\bautoplay\b/);
    }
    assert.match(
      html,
      /<img[^>]*src="\/api\/attachments\/image-id\?preview=1"/,
    );
    for (const id of ["svg-id", "html-id", "unknown-id"]) {
      assert.match(html, new RegExp(`href="/api/attachments/${id}"`));
      assert.doesNotMatch(html, new RegExp(`src="/api/attachments/${id}`));
    }
    assert.match(html, /href="\/api\/attachments\/movie%2Fid"/);
    assert.doesNotMatch(html, /private-bucket|<script>|autoplay/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;\.wav/);
  }
});

test(
  "authenticated media plays, seeks and fits notebook/export viewports under CSP",
  { skip: !process.env.UI_BROWSER_PATH && !existsSync(mediaBrowserPath) },
  async () => {
    const { chromium } = await import("playwright");
    const { spawn } = await import("node:child_process");
    const { mkdtempSync, rmSync, lstatSync, readdirSync, realpathSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join, dirname, basename } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "process-log-media-ui-"));
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
          () => reject(new Error("Media fixture startup timeout")),
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
        fixture.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        fixture.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Media fixture exited ${code}`));
        });
        fixture.stderr.on("data", (chunk) => process.stderr.write(chunk));
      });
      browser = await chromium.launch({
        executablePath: mediaBrowserPath,
        headless: true,
        args: ["--autoplay-policy=no-user-gesture-required"],
      });
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      await context.addInitScript(() => {
        window.print = () => {};
      });
      const page = await context.newPage();
      const errors = [],
        responses = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      page.on("response", (response) => {
        if (response.url().includes("/api/attachments/"))
          responses.push(response);
      });
      const base = `http://127.0.0.1:${port}`;
      await page.goto(base);
      await page.locator('#login-form [name="username"]').fill("admin");
      await page
        .locator('#login-form [name="password"]')
        .fill("ui-test-password-only");
      await page.locator("#login-form button").click();
      await page.locator(".workspace").waitFor();
      const headers = {
        "X-Process-Log": "1",
        "X-Process-Log-Account": "owner",
      };
      const stateResponse = await page.request.get(base + "/api/state", {
        headers,
      });
      assert.equal(stateResponse.status(), 200);
      const record = (await stateResponse.json()).records[0];
      const wav = Buffer.alloc(8044, 128);
      wav.write("RIFF", 0);
      wav.writeUInt32LE(8036, 4);
      wav.write("WAVEfmt ", 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(8000, 24);
      wav.writeUInt32LE(8000, 28);
      wav.writeUInt16LE(1, 32);
      wav.writeUInt16LE(8, 34);
      wav.write("data", 36);
      wav.writeUInt32LE(8000, 40);
      // Encode a new tiny WebM in the isolated browser; no fixture or production media is reused.
      const webm = Buffer.from(
        await page.evaluate(async () => {
          const canvas = document.createElement("canvas");
          canvas.width = 64;
          canvas.height = 48;
          const paint = canvas.getContext("2d");
          paint.fillStyle = "green";
          paint.fillRect(0, 0, 64, 48);
          const stream = canvas.captureStream(10),
            chunks = [];
          const recorder = new MediaRecorder(stream, {
            mimeType: "video/webm;codecs=vp8",
          });
          const blob = await new Promise((resolve) => {
            recorder.ondataavailable = (event) => chunks.push(event.data);
            recorder.onstop = () =>
              resolve(new Blob(chunks, { type: "video/webm" }));
            recorder.start();
            setTimeout(() => recorder.stop(), 400);
          });
          stream.getTracks().forEach((track) => track.stop());
          return Array.from(new Uint8Array(await blob.arrayBuffer()));
        }),
      );
      const ids = [];
      for (const [name, mime, data] of [
        ["isolated.wav", "audio/wav", wav],
        ["isolated.webm", "video/webm", webm],
      ]) {
        const response = await page.request.post(
          base + `/api/records/${record.id}/attachments`,
          {
            headers: { ...headers, "Content-Type": mime, "X-Filename": name },
            data,
          },
        );
        assert.equal(response.status(), 200);
        ids.push((await response.json()).id);
      }
      const update = await page.request.put(
        base + `/api/records/${record.id}`,
        {
          headers,
          data: {
            version: record.version,
            cells: [
              ...record.cells,
              {
                id: "f".repeat(32),
                type: "file",
                source: "",
                language: "",
                attachment_ids: ids,
              },
            ],
          },
        },
      );
      assert.equal(update.status(), 200, await update.text());
      await page.reload();
      await page.locator("[data-action=select]").first().click();
      for (const tag of ["audio", "video"]) {
        const media = page.locator(`.nb-file ${tag}`);
        await media.waitFor();
        await page.waitForFunction(
          (tag) => document.querySelector(`.nb-file ${tag}`)?.readyState >= 1,
          tag,
        );
        assert.equal(
          await media.evaluate((element) => getComputedStyle(element).maxWidth),
          "100%",
        );
        assert.equal(
          await media.evaluate(
            (element) => element.controls && element.preload === "metadata",
          ),
          true,
        );
        assert.equal(
          await media.evaluate(
            (element) => new URL(element.src).origin === location.origin,
          ),
          true,
        );
        await media.evaluate((element) => element.play());
        await page.waitForFunction(
          (tag) => document.querySelector(`.nb-file ${tag}`).currentTime > 0,
          tag,
        );
        await media.evaluate((element) => element.pause());
      }
      const audio = page.locator(".nb-file audio");
      assert.equal(await audio.evaluate((element) => element.duration), 1);
      await audio.evaluate(
        (element) =>
          new Promise((resolve) => {
            element.addEventListener("seeked", resolve, { once: true });
            element.currentTime = 0.5;
          }),
      );
      assert.equal(await audio.evaluate((element) => element.currentTime), 0.5);
      await page.setViewportSize({ width: 390, height: 844 });
      for (const media of [audio, page.locator(".nb-file video")]) {
        assert(
          await media.evaluate(
            (element) =>
              element.getBoundingClientRect().width <=
              element.parentElement.clientWidth,
          ),
        );
      }
      const popupPromise = page.waitForEvent("popup");
      await page.locator('[data-nb="export-notebook-pdf"]').click();
      const popup = await popupPromise;
      popup.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await popup.setViewportSize({ width: 390, height: 844 });
      for (const tag of ["audio", "video"]) {
        const media = popup.locator(`.nb-export-attachment ${tag}`);
        await media.waitFor();
        assert.equal(
          await media.evaluate((element) => getComputedStyle(element).maxWidth),
          "100%",
        );
        assert(
          await media.evaluate(
            (element) =>
              element.getBoundingClientRect().width <=
              element.parentElement.clientWidth,
          ),
        );
      }
      for (const response of responses.filter(
        (response) => response.request().method() === "GET",
      )) {
        assert.equal(response.status(), 206);
        assert.equal(response.headers()["cache-control"], "no-store");
        assert.equal(response.headers()["accept-ranges"], "bytes");
      }
      assert(
        responses.some((response) => response.request().method() === "GET"),
        "native media must actually fetch authenticated bytes",
      );
      assert.deepEqual(errors, []);
    } finally {
      if (browser) await browser.close();
      const exited = new Promise((resolve) => fixture.once("exit", resolve));
      if (fixture.exitCode === null) {
        fixture.kill();
        await exited;
      }
      // Validate this exact mkdtemp target and every entry before recursive cleanup.
      assert.equal(dirname(realpathSync(root)), realpathSync(tmpdir()));
      assert(basename(root).startsWith("process-log-media-ui-"));
      assert(
        lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(),
      );
      const directories = [root];
      for (const directory of directories) {
        for (const name of readdirSync(directory)) {
          const entry = join(directory, name),
            stat = lstatSync(entry);
          assert(
            !stat.isSymbolicLink(),
            "refuse cleanup through a link or junction",
          );
          if (stat.isDirectory()) directories.push(entry);
          else
            assert(
              stat.isFile(),
              "refuse cleanup of unexpected filesystem entries",
            );
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);
